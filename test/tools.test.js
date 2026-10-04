'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execute, command, target } = require('../cli/tools');
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-tools-'));
 const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 return { root, cwd };
}
const context = (cwd, mode = 'auto', approve = async () => false) => ({ cwd, mode, approve, signal: new AbortController().signal });
test('auto edits project files; preserves exact replacement including dollar signs', async t => {
 const { cwd } = await fixture(t);
 assert.equal((await execute('write_file', { path: 'src/a.txt', content: 'hello\n' }, context(cwd))).created, true);
 assert.equal((await execute('edit_file', { path: 'src/a.txt', old_string: 'hello', new_string: '$& world' }, context(cwd))).error, undefined);
 assert.equal(await fs.readFile(path.join(cwd, 'src/a.txt'), 'utf8'), '$& world\n');
});
test('ask denies writes; auto denies shell, Git and network without consent', async t => {
 const { cwd } = await fixture(t);
 for (const [name, args, mode] of [
  ['write_file', { path: 'a', content: 'x' }, 'ask'],
  ['run_command', { command: 'touch danger' }, 'auto'],
  ['git', { args: ['init'] }, 'auto'],
  ['fetch_url', { url: 'http://127.0.0.1:1' }, 'auto'],
  ['write_file', { path: '.git/config', content: 'x' }, 'auto'],
 ]) assert.equal((await execute(name, args, context(cwd, mode))).denied, true);
 assert.deepEqual(await fs.readdir(cwd), []);
});
test('external and symlink paths require approval, including dangling symlinks', async t => {
 const { cwd, root } = await fixture(t);
 await fs.writeFile(path.join(root, 'outside'), 'secret');
 await fs.symlink(path.join(root, 'outside'), path.join(cwd, 'link'));
 await fs.symlink(path.join(root, 'new-file'), path.join(cwd, 'dangling'));
 for (const file of ['../outside', 'link', 'dangling']) {
  assert.equal((await execute('write_file', { path: file, content: 'changed' }, context(cwd))).denied, true);
 }
 assert.equal((await execute('read_file', { path: 'link' }, context(cwd))).denied, true);
 assert.equal(await fs.readFile(path.join(root, 'outside'), 'utf8'), 'secret');
 assert.equal(await target(cwd, 'dangling'), path.join(root, 'new-file'));
});
test('auto requires approval for protected directories redirected inside the project', async t => {
 const { cwd } = await fixture(t);
 await fs.mkdir(path.join(cwd, 'metadata'));
 for (const name of ['.git', '.sekai']) {
  await fs.symlink(path.join(cwd, 'metadata'), path.join(cwd, name));
  const result = await execute('write_file', { path: `${name}/config`, content: 'changed' }, context(cwd));
  assert.equal(result.denied, true, name);
 }
 assert.deepEqual(await fs.readdir(path.join(cwd, 'metadata')), []);
});
test('edits reject ambiguous matches and concurrent changes during approval', async t => {
 const { cwd } = await fixture(t), file = path.join(cwd, 'a');
 await fs.writeFile(file, 'same same');
 assert.match((await execute('edit_file', { path: 'a', old_string: 'same', new_string: 'next' }, context(cwd))).error, /2 matches/);
 const result = await execute('write_file', { path: 'a', content: 'new' }, context(cwd, 'ask', async () => { await fs.writeFile(file, 'user edit'); return true; }));
 assert.match(result.error, /changed during approval/);
 assert.equal(await fs.readFile(file, 'utf8'), 'user edit');
});
test('approved commands report exit codes and abort kills running processes', async t => {
 const { cwd } = await fixture(t);
 const result = await command(process.execPath, ['-e', 'console.log("hello"); process.exit(7)'], cwd, new AbortController().signal);
 assert.equal(result.code, 7); assert.match(result.output, /hello/);
 const controller = new AbortController();
 const pending = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], cwd, controller.signal);
 setTimeout(() => controller.abort(), 80);
 assert.equal((await pending).cancelled, true);
});

test('malformed tool arguments are rejected before rendering, approval, or file changes', async t => {
 const { cwd } = await fixture(t);
 await fs.writeFile(path.join(cwd, 'a'), 'same same');
 for (const [name, args] of [
  ['git', { args: 'status' }],
  ['git', { args: [1] }],
  ['edit_file', { path: 'a', old_string: 'same', new_string: 'changed', replace_all: 'false' }],
  ['read_file', { path: 'a', offset: 1.5 }],
  ['list_files', { path: null }],
  ['write_file', { path: 'a', content: 'changed', unexpected: true }],
 ]) {
  const events = [];
  const result = await execute(name, args, { ...context(cwd, 'full'), emit: event => events.push(event) });
  assert.match(result.error || '', /argument|must be|unsupported/i, name);
  assert.deepEqual(events, [], name);
 }
 assert.equal(await fs.readFile(path.join(cwd, 'a'), 'utf8'), 'same same');
});

test('write_file does not overwrite a new empty file created during approval', async t => {
 const { cwd } = await fixture(t);
 const result = await execute('write_file', { path: 'new', content: 'replacement' }, context(cwd, 'ask', async () => {
  await fs.writeFile(path.join(cwd, 'new'), ''); return true;
 }));
 assert.match(result.error || '', /changed during approval/);
 assert.equal(await fs.readFile(path.join(cwd, 'new'), 'utf8'), '');
});

test('fetch_url handles responses without a body and flushes UTF-8 decoding', async t => {
 const { cwd } = await fixture(t);
 const original = global.fetch; t.after(() => global.fetch = original);
 for (const status of [204, 205, 304]) {
  global.fetch = async () => new Response(null, { status });
  const result = await execute('fetch_url', { url: 'https://example.test' }, context(cwd, 'full'));
  assert.equal(result.error, undefined); assert.equal(result.status, status);
  assert.equal(result.text, ''); assert.equal(result.truncated, false);
 }
 global.fetch = async () => new Response(new Uint8Array([0x61, 0xe2, 0x82]));
 const result = await execute('fetch_url', { url: 'https://example.test' }, context(cwd, 'full'));
 assert.equal(result.text, 'a\ufffd');
});
