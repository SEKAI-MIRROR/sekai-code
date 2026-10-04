'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OpenAI = require('../cli/adapters/openai');
const Providers = require('../cli/providers');
test('Responses parser handles CRLF split across network chunks', async t => {
 const original = global.fetch; t.after(() => global.fetch = original);
 const encoder = new TextEncoder();
 const data = [
  'data: {"type":"response.output_text.delta","delta":"hello"}\r',
  '\n\r', '\n',
  'data: {"type":"response.completed","response":{}}\r', '\n\r', '\n',
 ];
 global.fetch = async () => new Response(new ReadableStream({ start(controller) { data.forEach(s => controller.enqueue(encoder.encode(s))); controller.close(); } }));
 const result = await OpenAI.stream({ provider: 'openai', model: 'test', key: 'test', messages: [] }, {});
 assert.equal(result.content, 'hello'); assert.equal(result.finishReason, 'stop');
});

test('DeepSeek handles a final event without a newline and multiline SSE data', async t => {
 const original = global.fetch; t.after(() => global.fetch = original);
 for (const data of [
  'data: {"choices":[{"delta":{"content":"hello"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: {"choices":\r\ndata: [{"delta":{"content":"hello"},"finish_reason":"stop"}]}\r\n\r\n',
 ]) {
  global.fetch = async () => new Response(data);
  const reply = await Providers.stream({ provider: 'deepseek', model: 'test' }, 'test', [], [], new AbortController().signal, () => {});
  assert.equal(reply.content, 'hello'); assert.equal(reply.finishReason, 'stop');
 }
});
