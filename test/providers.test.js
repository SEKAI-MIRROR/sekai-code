'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OpenAI = require('../desktop/openai');
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
