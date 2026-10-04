'use strict';
const OpenAI = require('../desktop/openai');
const Gateway = require('../desktop/sekai');
const { roots } = require('./config');
const base = options => (options.baseUrl || roots[options.provider]).replace(/\/+$/, '');
async function failure(response) {
 const body = await response.json().catch(() => ({}));
 throw new Error(body.error?.message || `Provider returned HTTP ${response.status}`);
}
async function models(options, key, signal) {
 if (options.provider === 'sekai') return (await Gateway.models({ key }, { baseURL: base(options), signal })).map(m => ({ ...m, id: m.api }));
 const headers = options.provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` };
 const response = await fetch(`${base(options)}${options.provider === 'anthropic' ? '/v1' : ''}/models`, { headers, signal });
 if (!response.ok) await failure(response);
 return ((await response.json()).data || []).map(m => ({ id: m.id, name: m.display_name || m.name || m.id }));
}
async function* events(body) {
 let buffer = '';
 const decoder = new TextDecoder();
 for await (const chunk of body) {
  buffer += decoder.decode(chunk, { stream: true });
  let pos;
  while ((pos = buffer.indexOf('\n')) !== -1) {
   const line = buffer.slice(0, pos).trimEnd(); buffer = buffer.slice(pos + 1);
   if (!line.startsWith('data:')) continue;
   const data = line.slice(5).trim();
   if (data === '[DONE]') { yield { done: true }; return; }
   if (data) yield JSON.parse(data);
  }
 }
}
async function stream(options, key, messages, tools, signal, onEvent, session) {
 const request = { provider: options.provider, key, model: options.model, effort: options.effort, messages, tools, session, maxTokens: 8192 };
 if (options.provider === 'sekai') return Gateway.stream(request, { signal, onEvent, baseURL: base(options) });
 if (options.provider === 'openai') {
  const result = await OpenAI.stream(request, { signal, onEvent, apiUrl: base(options) });
  if (!result.finishReason) throw new Error('Provider stream ended before completion. Please retry.');
  return result;
 }
 if (options.provider === 'anthropic') return require('../desktop/anthropic').stream({ ...request, once: true }, { signal, onEvent, baseURL: base(options) });
 const response = await fetch(`${base(options)}/chat/completions`, {
  method: 'POST', signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: options.model, messages: messages.map(({ native, ...m }) => m), tools, stream: true, stream_options: { include_usage: true }, ...(options.effort ? { thinking: { type: options.effort === 'none' ? 'disabled' : 'enabled' }, reasoning_effort: options.effort } : {}) }),
 });
 if (!response.ok) await failure(response);
 const result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
 for await (const event of events(response.body)) {
  if (event.error) throw new Error(event.error.message);
  if (event.usage) result.usage = event.usage;
  const choice = event.choices?.[0], delta = choice?.delta || {};
  if (delta.content) { result.content += delta.content; onEvent({ type: 'content', delta: delta.content }); }
  if (delta.reasoning_content) result.reasoning += delta.reasoning_content;
  for (const item of delta.tool_calls || []) {
   const call = result.toolCalls[item.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
   if (item.id) call.id = item.id;
   call.function.name += item.function?.name || '';
   call.function.arguments += item.function?.arguments || '';
  }
  if (choice?.finish_reason) result.finishReason = choice.finish_reason;
 }
 if (!result.finishReason) throw new Error('Provider stream ended before completion. Please retry.');
 result.toolCalls = result.toolCalls.filter(Boolean);
 return result;
}
module.exports = { stream, models };
