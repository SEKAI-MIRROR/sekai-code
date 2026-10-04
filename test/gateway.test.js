'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Gateway = require('../desktop/sekai');
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
test('desktop gateway keys import the CLI login and honor deletion across restarts', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-vault-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const local = path.join(root, 'cli'), desktop = path.join(root, 'desktop');
 await fs.mkdir(local); await fs.writeFile(path.join(local, 'credentials.json'), JSON.stringify({ sekai: { key: 'private-test', origin: 'https://api.sekaigateway.xyz' } }));
 const handlers = new Map();
 const electron = { app: { getPath: () => desktop }, ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) }, safeStorage: { isEncryptionAvailable: () => false } };
 const source = await fs.readFile(path.resolve(__dirname, '../desktop/keys.js'), 'utf8');
 const module = { exports: {} };
 vm.runInNewContext(source, { require: id => id === 'electron' ? electron : id === './sekai' ? Gateway : require(id), module, process: { env: { SEKAI_HOME: local } }, URL, Atomics, SharedArrayBuffer, Int32Array });
 const vault = module.exports; vault.register(() => true); vault.load();
 let event = {}; handlers.get('keys:read')(event); assert.equal(event.returnValue.sekai, 'private-test');
 await handlers.get('keys:write')({}, 'sekai', '');
 vault.load(); event = {}; handlers.get('keys:read')(event); assert.equal(event.returnValue.sekai, undefined);
});
