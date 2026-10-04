'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { selectSession, prepareResume } = require('../cli/resume');

async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-resume-'));
 const previous = process.env.SEKAI_HOME;
 process.env.SEKAI_HOME = path.join(root, 'state');
 t.after(async () => {
  if (previous === undefined) delete process.env.SEKAI_HOME; else process.env.SEKAI_HOME = previous;
  await fs.rm(root, { recursive: true, force: true });
 });
 const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
 const dir = path.join(process.env.SEKAI_HOME, 'sessions'); await fs.mkdir(dir, { recursive: true });
 const session = { id: 'saved', cwd, provider: 'openai', model: 'saved-model', updated: '2026-01-01T12:00:00Z', title: 'Fix login', tokens: 12, messages: [{ role: 'user', content: 'Earlier task' }, { role: 'assistant', content: 'Earlier response' }] };
 const save = value => fs.writeFile(path.join(dir, `${value.id}.json`), JSON.stringify(value));
 await save(session);
 const options = { provider: 'sekai', model: 'current-model', approval: 'ask', maxTurns: 40, maxAgents: 3, baseUrl: 'https://current.example/v1', effort: 'high' };
 return { root, cwd, session, save, options };
}

test('resume restores conversation and usage while keeping current permissions and explicit endpoint', async t => {
 const { cwd, session, save, options } = await fixture(t);
 await save({ ...session, approval: 'full', baseUrl: 'https://saved.example', key: 'fixture-only' });
 const next = await prepareResume('saved', { options, cwd, flags: { 'base-url': options.baseUrl } });
 assert.deepEqual(next.session.messages, session.messages); assert.equal(next.session.tokens, 12);
 assert.equal(next.options.provider, 'openai'); assert.equal(next.options.model, 'saved-model');
 assert.equal(next.options.approval, 'ask'); assert.equal(next.options.baseUrl, options.baseUrl);
 assert.equal(next.options.key, undefined); assert.equal(next.options.effort, undefined);
 assert.equal(options.provider, 'sekai'); assert.equal(options.effort, 'high');
 const yolo = await prepareResume('saved', { options: { ...options, approval: 'full' }, cwd });
 assert.equal(yolo.options.approval, 'full'); assert.equal(yolo.options.baseUrl, undefined);
});

test('explicit provider, model and effort take precedence over saved settings', async t => {
 const { cwd, options } = await fixture(t);
 const next = await prepareResume('saved', { options, cwd, flags: { provider: 'sekai', model: 'current-model', effort: 'high' } });
 assert.deepEqual(next.options, options);
});

test('failed resume leaves current settings unchanged and rejects missing projects or invalid sessions', async t => {
 const { root, cwd, session, save, options } = await fixture(t);
 const before = structuredClone(options);
 await assert.rejects(prepareResume('missing', { options, cwd }), /Session not found/);
 await assert.rejects(prepareResume('../saved', { options, cwd }), /Invalid session ID/);
 await assert.rejects(prepareResume('saved', { options, cwd: root, flags: { cwd: root } }), /original project/);
 await save({ ...session, cwd: path.join(root, 'deleted') });
 await assert.rejects(prepareResume('saved', { options, cwd }), /directory is not available/);
 await save({ ...session, messages: null });
 await assert.rejects(prepareResume('saved', { options, cwd }), /Invalid saved session/);
 assert.deepEqual(options, before);
});

test('session picker sorts parent sessions, includes searchable metadata, and supports cancellation', async t => {
 const { cwd, session, save, options } = await fixture(t);
 await save({ ...session, id: 'newer', title: 'New task', updated: '2026-02-01T12:00:00Z' });
 await save({ ...session, id: 'child', parentId: 'newer', updated: '2026-03-01T12:00:00Z' });
 const terminal = { rich: true, select: async (title, items, current, pickerOptions) => {
  assert.equal(title, 'Resume session'); assert.deepEqual(items.map(item => item.value), ['newer', 'saved']);
  assert.match(items[1].description, /2 messages/); assert(items[1].description.includes(cwd));
  assert.equal(pickerOptions.placeholder, 'Search sessions…');
  return null;
 } };
 assert.equal(await selectSession(terminal), null);
 assert.equal((await prepareResume('latest', { options, cwd })).session.id, 'newer');
});

test('plain picker accepts a number or ID and handles empty sessions', async t => {
 const { root } = await fixture(t);
 const terminal = { rich: false, note: () => {}, ask: async () => '1' };
 assert.equal(await selectSession(terminal), 'saved');
 terminal.ask = async () => 'saved'; assert.equal(await selectSession(terminal), 'saved');
 terminal.ask = async () => ''; assert.equal(await selectSession(terminal), null);
 terminal.ask = async () => '5'; await assert.rejects(selectSession(terminal), /Invalid session number/);
 await fs.rm(path.join(root, 'state', 'sessions'), { recursive: true });
 terminal.ask = async () => assert.fail('Empty sessions must not prompt');
 terminal.note = text => assert.match(text, /No saved sessions/);
 assert.equal(await selectSession(terminal), null);
});
