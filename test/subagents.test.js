'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../cli/agent');
const { Subagents } = require('../cli/subagents');
const call = (name, args, id = name) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const response = (content = '', toolCalls = []) => ({ content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 } });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, overrides = {}) {
 const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-workers-'));
 t.after(() => fs.rm(cwd, { recursive: true, force: true }));
 await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Keep changes scoped to the assigned file.');
 await fs.writeFile(path.join(cwd, 'sample.txt'), 'shared project');
 const session = { id: 'parent', cwd, provider: 'sekai', model: 'test', messages: [] };
 const events = [], saved = new Map(), controller = new AbortController();
 return { session, events, saved, controller, input: { session, options: { provider: 'sekai', model: 'test', baseUrl: 'http://127.0.0.1:1', maxTurns: 8, maxAgents: 3, approval: 'ask', ...overrides }, key: 'test-only-key', prompt: 'Use sub-agents for independent tasks.', signal: controller.signal, approve: async () => false, emit: e => events.push(e), save: async s => saved.set(s.id, structuredClone(s)) } };
}

test('workers run concurrently with independent contexts and inherited transport; parent collects reports and total usage', async t => {
 const { input, session, saved, events } = await fixture(t);
 session.messages.push({ role: 'user', content: 'Older private parent conversation.' });
 let parentCalls = 0, active = 0, peak = 0; const children = new Map(), both = gate();
 const result = await run({ ...input, stream: async (options, key, messages, tools, signal, emit, id) => {
  if (id === 'parent') {
   parentCalls++;
   assert(tools.some(t => t.function.name === 'spawn_agent'));
   if (parentCalls === 1) return response('', [call('spawn_agent', { name: 'Alpha', task: 'Inspect sample.txt; do not edit.' }, 'a'), call('spawn_agent', { name: 'Beta', task: 'Review AGENTS.md; do not edit.' }, 'b')]);
   if (parentCalls === 2) return response('', [call('wait_agents', {})]);
   const reports = JSON.parse(messages.at(-1).content).agents;
   assert.equal(reports.length, 2); assert(reports.every(a => a.status === 'completed' && a.result.includes('Report')));
   return response('Combined report.');
  }
  assert.equal(key, input.key); assert.equal(options.provider, input.options.provider); assert.equal(options.model, input.options.model); assert.equal(options.baseUrl, input.options.baseUrl);
  assert.equal(options.approval, 'ask'); assert.equal(options.maxAgents, 0);
  assert(!tools.some(t => t.function.name === 'spawn_agent'));
  assert(!JSON.stringify(messages).includes('Older private parent'));
  assert.match(messages[0].content, /Keep changes scoped/);
  const count = (children.get(id) || 0) + 1; children.set(id, count);
  if (count === 1) {
   active++; peak = Math.max(peak, active); if (active === 2) both.resolve();
   await both.promise; active--;
   return response('', [call('read_file', { path: 'sample.txt' })]);
  }
  assert.match(messages.at(-1).content, /shared project/);
  emit({ type: 'content', delta: 'Report from child.' });
  return response('Report from child.');
 } });
 assert.equal(result, 'Combined report.'); assert.equal(peak, 2);
 assert.equal(session.tokens, 35); assert.deepEqual(session.usage, { input: 21, output: 14 });
 assert.equal(saved.size, 3);
 assert.equal([...saved.values()].filter(s => s.parentId === 'parent').length, 2);
 assert(!JSON.stringify([...saved.values()]).includes(input.key));
 assert.equal(events.filter(e => e.type === 'subagent_start').length, 2);
 assert.equal(events.filter(e => e.type === 'subagent_end').length, 2);
 assert.equal(events.at(-1).type, 'turn_end');
});

test('concurrency limit rejects excess spawns and wait frees capacity', async t => {
 const { input, session } = await fixture(t, { maxAgents: 1 }); let parentCalls = 0; const release = gate();
 await run({ ...input, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id !== 'parent') { await release.promise; return response('Worker done'); }
  parentCalls++;
  if (parentCalls === 1) return response('', [call('spawn_agent', { name: 'First', task: 'Inspect' }, 'a'), call('spawn_agent', { name: 'Excess', task: 'Inspect' }, 'b')]);
  if (parentCalls === 2) { assert.match(messages.at(-1).content, /At most 1/); release.resolve(); return response('', [call('wait_agents', {})]); }
  if (parentCalls === 3) return response('', [call('spawn_agent', { name: 'Next', task: 'Inspect another file' })]);
  if (parentCalls === 4) return response('', [call('wait_agents', {})]);
  return response('Done');
 } });
 assert.equal(session.subagents.length, 2); assert(session.subagents.every(a => a.status === 'completed'));
});

test('disabled workers and recursive delegation are rejected by the host', async t => {
 const { input, session } = await fixture(t, { maxAgents: 0 }); let calls = 0;
 await run({ ...input, stream: async (o, k, messages, tools) => {
  assert(!tools.some(t => t.function.name === 'spawn_agent'));
  if (!calls++) return response('', [call('spawn_agent', { name: 'Forbidden', task: 'Inspect' })]);
  assert.match(messages.at(-1).content, /Unknown tool: spawn_agent/); return response('Done');
 } });
 assert.equal(session.subagents.length, 0);
 input.options.maxAgents = 1; calls = 0; let childCalls = 0;
 await run({ ...input, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id === 'parent') {
   if (!calls++) return response('', [call('spawn_agent', { name: 'Child', task: 'Inspect' })]);
   if (calls === 2) return response('', [call('wait_agents', {})]);
   return response('Done');
  }
  if (!childCalls++) return response('', [call('spawn_agent', { name: 'Grandchild', task: 'Inspect' })]);
  assert.match(messages.at(-1).content, /Unknown tool: spawn_agent/); return response('Cannot recurse');
 } });
 assert.equal(session.subagents.length, 1);
});

test('workers cannot escalate permissions or bypass ask mode', async t => {
 const { input, session } = await fixture(t); let parentCalls = 0, childCalls = 0;
 const approvals = [];
 await run({ ...input, approve: async action => { approvals.push(action); return false; }, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id === 'parent') {
   parentCalls++;
   if (parentCalls === 1) return response('', [call('spawn_agent', { name: 'Unsafe', task: 'Write a file', approval: 'full' }, 'bad'), call('spawn_agent', { name: 'Writer', task: 'Write blocked.txt' }, 'good')]);
   if (parentCalls === 2) { assert.match(messages.findLast(m => m.tool_call_id === 'bad').content, /Unsupported sub-agent option/); return response('', [call('wait_agents', {})]); }
   return response('Write denied');
  }
  if (!childCalls++) return response('', [call('write_file', { path: 'blocked.txt', content: 'no' })]);
  assert(JSON.parse(messages.at(-1).content).denied); return response('Permission denied');
 } });
 assert.equal(approvals.length, 1); assert.equal(approvals[0].agentName, 'Writer'); assert(approvals[0].signal instanceof AbortSignal);
 await assert.rejects(fs.access(path.join(session.cwd, 'blocked.txt')));
 assert.equal(session.subagents.length, 1);
});

for (const decision of [true, 'full']) test(`concurrent worker approvals are serialized and respect decision ${decision}`, async t => {
 const { input, session } = await fixture(t); let parentCalls = 0, active = 0, peak = 0; const childCalls = new Set();
 const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-outside-'));
 t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, 'data'), 'outside');
 const approvals = [];
 await run({ ...input, approve: async action => {
  active++; peak = Math.max(peak, active); approvals.push(action.agentName);
  await new Promise(resolve => setTimeout(resolve, 20)); active--; return decision;
 }, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id === 'parent') {
   if (!parentCalls++) return response('', [call('spawn_agent', { name: 'A', task: 'Read external data' }, 'a'), call('spawn_agent', { name: 'B', task: 'Read external data' }, 'b')]);
   if (parentCalls === 2) return response('', [call('wait_agents', {})]);
   return response('Done');
  }
  if (!childCalls.has(id)) { childCalls.add(id); return response('', [call('read_file', { path: path.join(outside, 'data') })]); }
  assert.match(messages.at(-1).content, /outside/); return response('Read');
 } });
 assert.equal(peak, 1);
 if (decision === 'full') { assert.equal(approvals.length, 1); assert.equal(input.options.approval, 'full'); }
 else assert.deepEqual(approvals.sort(), ['A', 'B']);
 assert(session.subagents.every(a => a.status === 'completed'));
});

test('root cancellation aborts all workers and records valid interrupted tool histories', async t => {
 const { input, session, controller, saved } = await fixture(t); let active = 0; const started = gate();
 const running = run({ ...input, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id === 'parent') {
   if (!messages.some(m => m.role === 'tool')) return response('', [call('spawn_agent', { name: 'A', task: 'Wait' }, 'a'), call('spawn_agent', { name: 'B', task: 'Wait' }, 'b')]);
   return response('', [call('wait_agents', {})]);
  }
  active++; if (active === 2) started.resolve();
  try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
  finally { active--; }
 } });
 await started.promise; controller.abort(); await assert.rejects(running, /abort/i);
 assert.equal(active, 0); assert.equal(session.subagents.length, 2); assert(session.subagents.every(a => a.status === 'cancelled'));
 const parent = saved.get('parent');
 for (const msg of parent.messages.filter(m => m.tool_calls)) for (const tool of msg.tool_calls) assert(parent.messages.some(m => m.tool_call_id === tool.id));
});

test('cancel_agent stops one worker and parent continues', async t => {
 const { input, session } = await fixture(t); let parentCalls = 0;
 await run({ ...input, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id !== 'parent') {
   signal.throwIfAborted();
   return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }
  if (!parentCalls++) return response('', [call('spawn_agent', { name: 'Slow', task: 'Wait' })]);
  if (parentCalls === 2) return response('', [call('cancel_agent', { id: session.subagents[0].id })]);
  assert.equal(JSON.parse(messages.at(-1).content).status, 'cancelled'); return response('Cancelled worker');
 } });
 assert.equal(session.subagents[0].status, 'cancelled');
});

test('uncollected reports and worker failures are fed back before the parent finishes', async t => {
 const { input, session } = await fixture(t); let parentCalls = 0;
 const result = await run({ ...input, stream: async (o, k, messages, tools, signal, emit, id) => {
  if (id !== 'parent') throw new Error('Provider unavailable');
  if (!parentCalls++) return response('', [call('spawn_agent', { name: 'Research', task: 'Inspect' })]);
  if (parentCalls === 2) return response('Premature final answer');
  assert.match(messages.at(-1).content, /Provider unavailable/); assert(!('internal' in messages.at(-1)));
  return response('The delegated task failed.');
 } });
 assert.equal(result, 'The delegated task failed.'); assert.equal(session.subagents[0].status, 'failed');
 assert(session.messages.some(m => m.internal));
});

test('per-turn spawn budget is bounded and saved running records become interrupted', async () => {
 const session = { id: 'parent', cwd: os.tmpdir(), subagents: [{ id: 'old', status: 'running', name: 'Old task' }] };
 const manager = new Subagents({ session, options: { maxAgents: 1 }, signal: new AbortController().signal, save: async () => {}, emit: () => {}, runWorker: async () => 'done' });
 assert.equal(manager.list()[0].status, 'interrupted');
 for (let i = 0; i < 4; i++) { await manager.execute('spawn_agent', { name: `Task ${i}`, task: 'Inspect' }); await manager.wait(); }
 await assert.rejects(manager.execute('spawn_agent', { name: 'Excess', task: 'Inspect' }), /limit for this user turn/);
 await manager.close();
});
