'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../cli/agent');
test('agent loops through real tools, carries results, usage and scoped instructions', async t => {
 const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-agent-'));
 t.after(() => fs.rm(cwd, { recursive: true, force: true }));
 await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Always use tabs.');
 const session = { id: 'test', cwd, messages: [] }, events = []; let requests = 0;
 await run({ session, options: { provider: 'openai', approval: 'auto', maxTurns: 3 }, key: 'test', prompt: 'Create a file', signal: new AbortController().signal, approve: async () => false, emit: e => events.push(e), save: async () => {}, stream: async (o, k, messages) => {
  requests++;
  assert.match(messages[0].content, /Always use tabs/);
  if (requests === 1) return { content: 'Creating.', toolCalls: [{ id: 'call-1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'done' }) } }], usage: { total_tokens: 10 } };
  assert.equal(JSON.parse(messages.at(-1).content).created, true);
  return { content: 'Done.', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
 } });
 assert.equal(await fs.readFile(path.join(cwd, 'made.txt'), 'utf8'), 'done');
 assert.equal(session.tokens, 15); assert.equal(events.at(-1).type, 'turn_end');
 assert.deepEqual(session.usage, { input: 3, output: 2 });
});
test('interruption preserves valid history for all outstanding calls', async () => {
 const controller = new AbortController();
 const session = { id: 'test', cwd: os.tmpdir(), messages: [] }; let saved;
 await assert.rejects(run({ session, options: { provider: 'openai', approval: 'ask', maxTurns: 3 }, prompt: 'test', signal: controller.signal, approve: async () => false, emit: () => {}, save: async s => { saved = structuredClone(s); }, stream: async () => ({ toolCalls: ['a', 'b'].map(id => ({ id, function: { name: 'read_file', arguments: '{}' } })) }), execute: async () => { controller.abort(); controller.signal.throwIfAborted(); } }), /abort/i);
 assert.equal(saved.messages.filter(m => m.role === 'tool').length, 2);
});

test('session approval runs subsequent commands across turns and can be reset to ask', async t => {
 const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-approval-'));
 t.after(() => fs.rm(cwd, { recursive: true, force: true }));
 const session = { id: 'test', cwd, messages: [] }, events = [];
 const options = { provider: 'openai', approval: 'ask', maxTurns: 3, maxAgents: 0 };
 let approvals = 0;
 const turn = async decision => {
  let requests = 0;
  await run({ session, options, prompt: 'Run two commands', signal: new AbortController().signal,
   approve: async () => { approvals++; return decision; }, emit: e => events.push(e), save: async () => {},
   stream: async () => requests++ ? { content: 'Done' } : { toolCalls: ['one', 'two'].map(id => ({ id, function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo approved' }) } })) },
  });
 };
 await turn('full'); await turn(false);
 assert.equal(approvals, 1); assert.equal(options.approval, 'full');
 const results = events.filter(e => e.type === 'tool_end');
 assert.equal(results.length, 4);
 assert(results.every(e => e.result.code === 0 && /approved/.test(e.result.output)));
 assert.equal(events.filter(e => e.type === 'permission_mode').length, 1);
 assert.equal(session.approval, undefined);
 options.approval = 'ask';
 await turn(false);
 assert.equal(approvals, 3);
 assert(events.filter(e => e.type === 'tool_end').slice(-2).every(e => e.result.denied));
});

test('cancellation while selecting full does not enable session approval', async () => {
 const controller = new AbortController(), options = { provider: 'openai', approval: 'ask', maxTurns: 2, maxAgents: 0 };
 await assert.rejects(run({ session: { id: 'test', cwd: os.tmpdir(), messages: [] }, options, prompt: 'Run', signal: controller.signal,
  approve: async () => { controller.abort(); return 'full'; }, save: async () => {},
  stream: async () => ({ toolCalls: [{ id: 'one', function: { name: 'run_command', arguments: '{"command":"echo approved"}' } }] }),
 }), /abort/i);
 assert.equal(options.approval, 'ask');
});
