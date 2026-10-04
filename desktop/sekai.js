'use strict';

// Shared by the Node CLI and Electron main process. Requests stay on Sekai Gateway.
const BASE_URL = 'https://api.sekaigateway.xyz/v2';
const DEFAULT_MODEL = 'cx/gpt-5.6-sol';
const base = value => (value || BASE_URL).replace(/\/+$/, '');
const problem = (message, status = 0) => Object.assign(new Error(message), { status });
async function failure(response, key) {
 const body = await response.json().catch(() => ({}));
 const detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message;
 throw problem(String(detail || `Sekai Gateway returned HTTP ${response.status}`).replaceAll(key, '[REDACTED]'), response.status);
}
async function models({ key }, { baseURL, signal } = {}) {
 const response = await fetch(`${base(baseURL)}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal });
 if (!response.ok) await failure(response, key);
 const body = await response.json();
 if (!Array.isArray(body.data)) throw problem('Sekai Gateway returned an invalid model list.');
 return body.data.filter(model => typeof model.id === 'string').map(model => ({
  id: `sekai:${model.id}`, api: model.id, provider: 'sekai', name: model.name || model.display_name || model.id,
  context: Number(model.context_window) || 128000,
  vision: Array.isArray(model.input_modalities) && model.input_modalities.includes('image'),
  efforts: ['none'], defaultEffort: 'none',
 }));
}
async function* events(body) {
 if (!body) throw problem('Sekai Gateway returned an empty stream.');
 const decoder = new TextDecoder(); let buffer = '', data = [];
 const decode = () => { const text = data.join('\n').trim(); data = []; return text === '[DONE]' ? { done: true } : text ? JSON.parse(text) : null; };
 for await (const chunk of body) {
  buffer += decoder.decode(chunk, { stream: true });
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
   const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
   if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
   else if (!line) { const event = decode(); if (event) { yield event; if (event.done) return; } }
  }
 }
 buffer += decoder.decode();
 if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
 const final = decode(); if (final) yield final;
}
function convert(messages, vision = true) {
 return messages.map(message => {
  const out = { role: message.role, content: message.content ?? '' };
  if (!vision && Array.isArray(out.content)) out.content = out.content.map(part => part.type === 'text' ? part.text : '[Image omitted: this model has no advertised image support]').join('\n');
  if (message.tool_calls?.length) out.tool_calls = message.tool_calls;
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  const reasoning = message.native?.provider === 'sekai' ? message.native.reasoning : message.reasoning_content;
  if (reasoning) out.reasoning_content = reasoning;
  return out;
 });
}
async function stream(request, { signal, onEvent = () => {}, baseURL } = {}) {
 const { key, model, messages, tools, maxTokens, effort, vision = true } = request;
 const response = await fetch(`${base(baseURL)}/chat/completions`, {
  method: 'POST', redirect: 'error', signal,
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ model, messages: convert(messages, vision), stream: true, stream_options: { include_usage: true },
   ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
   ...(maxTokens ? { max_tokens: maxTokens } : {}),
   ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}),
  }),
 });
 if (!response.ok) await failure(response, key);
 const result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
 for await (const event of events(response.body)) {
  if (event.error) throw problem(String(event.error.message || event.error).replaceAll(key, '[REDACTED]'));
  if (event.usage) {
   const u = event.usage;
   result.usage = { ...u, total_tokens: u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0)), cached_tokens: u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0 };
  }
  const choice = event.choices?.[0], delta = choice?.delta || {};
  for (const [field, type] of [['content', 'content'], ['reasoning_content', 'reasoning']]) {
   if (typeof delta[field] === 'string') { result[type] += delta[field]; onEvent({ type, delta: delta[field] }); }
  }
  for (const part of delta.tool_calls || []) {
   const index = part.index ?? 0;
   if (!Number.isInteger(index) || index < 0 || index > 128) throw problem('Invalid tool call index from Sekai Gateway.');
   const call = result.toolCalls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
   if (part.id) call.id = part.id;
   if (part.function?.name) call.function.name += part.function.name;
   if (part.function?.arguments) call.function.arguments += part.function.arguments;
  }
  if (choice?.finish_reason) result.finishReason = choice.finish_reason;
 }
 if (!result.finishReason) throw problem('Sekai Gateway stream ended before completion. Please retry.');
 result.toolCalls = result.toolCalls.filter(Boolean);
 if (result.toolCalls.some(call => !call.id || !call.function.name)) throw problem('Sekai Gateway returned an incomplete tool call.');
 // Truncated tool arguments must never be executed.
 if (!['stop', 'tool_calls'].includes(result.finishReason)) result.toolCalls = [];
 if (result.reasoning) result.native = { provider: 'sekai', reasoning: result.reasoning };
 return result;
}
module.exports = { BASE_URL, DEFAULT_MODEL, models, stream, convert };
