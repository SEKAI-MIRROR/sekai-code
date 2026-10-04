'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Gateway = require('../cli/adapters/sekai');
function mockStream(t, parts) {
 const original = global.fetch; t.after(() => global.fetch = original);
 const encoder = new TextEncoder();
 global.fetch = async () => new Response(new ReadableStream({ start(controller) { parts.forEach(text => controller.enqueue(encoder.encode(text))); controller.close(); } }));
}
test('gateway parser handles CRLF and the last event without a trailing newline', async t => {
 mockStream(t, ['data: {"choices":[{"delta":{"content":"hello"}}]}\r', '\n\r', '\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}']);
 const reply = await Gateway.stream({ model: 'test', key: 'test', messages: [] });
 assert.equal(reply.content, 'hello'); assert.equal(reply.finishReason, 'stop');
});
test('gateway never executes truncated tool calls', async t => {
 mockStream(t, ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"write_file","arguments":"{partial"}}]},"finish_reason":"length"}]}\n\n']);
 const reply = await Gateway.stream({ model: 'test', key: 'test', messages: [] });
 assert.deepEqual(reply.toolCalls, []); assert.equal(reply.finishReason, 'length');
});
test('gateway rejects incomplete streams', async t => {
 mockStream(t, ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']);
 await assert.rejects(Gateway.stream({ model: 'test', key: 'test', messages: [] }), /before completion/);
});
