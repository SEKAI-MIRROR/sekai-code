'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const str = description => ({ type: 'string', description });
const schemas = [
 tool('read_file', 'Read a text file with line numbers, up to 2000 lines. Read before editing.', { path: str('Relative or absolute path'), offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path']),
 tool('list_files', 'List a directory tree without following symlinks; skips generated folders.', { path: str('Defaults to .'), depth: { type: 'integer' } }),
 tool('write_file', 'Create or replace a UTF-8 text file. Shows the user a change preview.', { path: str('File path'), content: str('Complete new contents') }, ['path', 'content']),
 tool('edit_file', 'Replace an exact unique string in an existing text file. Read the file first.', { path: str('File path'), old_string: str('Exact nonempty text'), new_string: str('Replacement'), replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
 tool('run_command', 'Run a shell command in the project. Always needs approval except in full mode. No interactive input. Prefer rg for search; do not start background processes.', { command: str('Shell command'), timeout: { type: 'integer', description: 'Seconds, default 120, maximum 900' } }, ['command']),
 tool('git', 'Run Git with an argument array; requires approval except in full mode.', { args: { type: 'array', items: { type: 'string' } } }, ['args']),
 tool('fetch_url', 'Fetch an HTTP(S) page as text; requires approval except in full mode.', { url: str('Full URL') }, ['url']),
];
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
async function realTarget(file, hops = 0) {
 if (hops > 40) throw new Error('Too many symbolic links.');
 try { return await fs.realpath(file); }
 catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat?.isSymbolicLink()) return realTarget(path.resolve(path.dirname(file), await fs.readlink(file)), hops + 1);
  const parent = path.dirname(file);
  if (parent === file) throw error;
  return path.join(await realTarget(parent, hops + 1), path.basename(file));
 }
}
async function target(cwd, file) {
 if (typeof file !== 'string' || !file.trim()) throw new Error('path must be a nonempty string');
 return realTarget(path.resolve(cwd, file));
}
function needsApproval(name, mode, cwd, resolved) {
 if (mode === 'full') return false;
 if (resolved && !inside(cwd, resolved)) return true;
 if (['read_file', 'list_files'].includes(name)) return false;
 if (mode === 'auto' && ['write_file', 'edit_file'].includes(name) && resolved) {
  const parts = path.relative(cwd, resolved).split(path.sep);
  return parts.some(part => ['.git', '.sekai'].includes(part));
 }
 return true;
}
function command(exe, args, cwd, signal, seconds = 120) {
 return new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const child = spawn(exe, args, { cwd, detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', total = 0, timedOut = false;
  const collect = chunk => { total += chunk.length; output = (output + chunk).slice(-30000); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const stop = () => {
   if (!child.pid) return;
   if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
   else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(900, Number(seconds) || 120)) * 1000);
  signal?.addEventListener('abort', stop, { once: true });
  let grace;
  const clean = () => { clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', stop); };
  const finish = code => { clean(); resolve({ code, output: (total > 30000 ? '[Earlier output truncated]\n' : '') + output, timedOut, cancelled: !!signal?.aborted }); };
  child.on('error', error => { clean(); reject(error); });
  child.on('exit', code => { grace = setTimeout(() => { stop(); child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 500); });
  child.on('close', finish);
 });
}
async function textFile(file) {
 const stat = await fs.stat(file);
 if (!stat.isFile()) throw new Error('Not a regular file.');
 if (stat.size > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MiB text limit. Use run_command to inspect selected portions.');
 const data = await fs.readFile(file);
 if (data.subarray(0, 8000).includes(0)) throw new Error('Binary files are not supported by this text tool.');
 return data.toString('utf8');
}
function preview(file, before, after) {
 const lines = [`--- ${file}`, `+++ ${file}`];
 const a = before.split('\n'), b = after.split('\n');
 let start = 0;
 while (start < a.length && start < b.length && a[start] === b[start]) start++;
 let endA = a.length, endB = b.length;
 while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
 lines.push(`@@ line ${start + 1} @@`, ...a.slice(start, endA).map(s => `- ${s}`), ...b.slice(start, endB).map(s => `+ ${s}`));
 const shown = lines.slice(0, 85).join('\n').slice(0, 10000);
 return shown + (lines.length > 85 || lines.join('\n').length > 10000 ? '\n[Preview truncated]' : '');
}
async function execute(name, args, { cwd, mode, signal, approve, emit = () => {} }) {
 const schema = schemas.find(t => t.function.name === name)?.function.parameters;
 if (!schema) return { error: `Unknown tool: ${name}` };
 try {
  signal?.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw new Error(`Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
   const spec = Object.hasOwn(schema.properties, key) && schema.properties[key];
   if (!spec) throw new Error(`Unsupported argument: ${key}`);
   const valid = spec.type === 'integer' ? Number.isInteger(value)
    : spec.type === 'array' ? Array.isArray(value) && value.every(item => typeof item === spec.items.type)
     : typeof value === spec.type;
   if (!valid) throw new Error(`Argument ${key} must be ${spec.type === 'array' ? 'an array of strings' : spec.type}.`);
  }
  const fileTool = ['read_file', 'write_file', 'edit_file', 'list_files'].includes(name);
  const resolved = fileTool ? await target(cwd, name === 'list_files' ? args.path || '.' : args.path) : null;
  const requested = fileTool ? path.resolve(cwd, name === 'list_files' ? args.path || '.' : args.path) : null;
  let before, after, existed = true;
  if (['write_file', 'edit_file'].includes(name)) {
   let externalPreview = false;
   if (mode !== 'full' && !inside(cwd, resolved)) {
    const read = { name: 'read_file', args: { path: resolved, purpose: 'Read external file to prepare a change preview' } };
    emit({ type: 'tool_start', ...read });
    if (!await approve(read)) {
     const result = { denied: true, error: 'User did not approve reading this external file. Do not retry by another route.' };
     emit({ type: 'tool_end', name: 'read_file', result }); return result;
    }
    signal?.throwIfAborted();
    externalPreview = true;
   }
   try { before = await textFile(resolved); } catch (error) {
    if (name !== 'write_file' || error.code !== 'ENOENT') {
     if (externalPreview) emit({ type: 'tool_end', name: 'read_file', result: { error: error.message } });
     throw error;
    }
    before = ''; existed = false;
   }
   if (externalPreview) emit({ type: 'tool_end', name: 'read_file', result: { path: resolved, output: existed ? 'Read for change preview.' : 'File does not exist yet.' } });
   if (name === 'write_file') {
    if (typeof args.content !== 'string') throw new Error('content must be a string');
    after = args.content;
   } else {
    if (typeof args.old_string !== 'string' || !args.old_string || typeof args.new_string !== 'string') throw new Error('Supply nonempty old_string and a new_string.');
    const crlf = before.includes('\r\n');
    const old = crlf ? args.old_string.replace(/\r?\n/g, '\r\n') : args.old_string;
    const next = crlf ? args.new_string.replace(/\r?\n/g, '\r\n') : args.new_string;
    const count = before.split(old).length - 1;
    if (!count || (count > 1 && !args.replace_all)) throw new Error(`Found ${count} matches. Read again and provide a unique exact match, or use replace_all.`);
    after = args.replace_all ? before.split(old).join(next) : before.replace(old, () => next);
   }
  }
  const change = after !== undefined ? preview(args.path, before, after) : null;
  emit({ type: 'tool_start', name, args, ...(change ? { preview: change } : {}) });
  // Both the named path and its symlink destination must satisfy the policy.
  const approvalRequired = needsApproval(name, mode, cwd, resolved) || (requested && needsApproval(name, mode, cwd, requested));
  if (approvalRequired && !await approve({ name, args, preview: change })) return { denied: true, error: 'User did not approve this action. Do not retry it by another route.' };
  signal?.throwIfAborted();
  // Recheck after a potentially long approval prompt; do not write a newly redirected path.
  if (resolved && await target(cwd, name === 'list_files' ? args.path || '.' : args.path) !== resolved) throw new Error('Path changed during approval. Read it again.');
  if (after !== undefined) {
   const current = await textFile(resolved).catch(error => { if (!existed && error.code === 'ENOENT') return null; throw error; });
   if (existed ? current !== before : current !== null) throw new Error('File changed during approval. Read it again before editing.');
   await fs.mkdir(path.dirname(resolved), { recursive: true });
   await fs.writeFile(resolved, after, { encoding: 'utf8', flag: existed ? 'w' : 'wx' });
   return { path: resolved, created: !existed, bytes: Buffer.byteLength(after) };
  }
  if (name === 'read_file') {
   const all = (await textFile(resolved)).split('\n'), offset = Math.max(1, Number(args.offset) || 1), limit = Math.max(1, Math.min(2000, Number(args.limit) || 250));
   return { path: resolved, total: all.length, text: all.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n').slice(0, 60000) };
  }
  if (name === 'list_files') {
   const entries = [], skip = new Set(['.git', 'node_modules', 'dist', '.venv', '__pycache__']);
   const walk = async (dir, depth) => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
     if (entries.length >= 500) return;
     const full = path.join(dir, entry.name);
     entries.push(path.relative(resolved, full) + (entry.isDirectory() ? '/' : entry.isSymbolicLink() ? ' [symlink]' : ''));
     if (entry.isDirectory() && depth > 1 && !skip.has(entry.name)) await walk(full, depth - 1);
    }
   };
   await walk(resolved, Math.max(1, Math.min(6, Number(args.depth) || 2)));
   return { path: resolved, entries, truncated: entries.length >= 500 };
  }
  if (name === 'run_command') {
   if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('command must be nonempty');
   return process.platform === 'win32'
    ? command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command], cwd, signal, args.timeout)
    : command('/bin/bash', ['-c', args.command], cwd, signal, args.timeout);
  }
  if (name === 'git') {
   if (!Array.isArray(args.args) || !args.args.length || args.args.some(s => typeof s !== 'string')) throw new Error('args must be a nonempty string array');
   return command('git', ['--no-pager', ...args.args], cwd, signal);
  }
  const url = new URL(args.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  const response = await fetch(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)]) });
  if (!response.body) return { status: response.status, url: response.url, text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let text = '';
  try { while (text.length < 60000) { const { value, done } = await reader.read(); if (done) { text += decoder.decode(); break; } text += decoder.decode(value, { stream: true }); } }
  finally { await reader.cancel(); }
  return { status: response.status, url: response.url, text: text.slice(0, 60000), truncated: text.length >= 60000 };
 } catch (error) { if (signal?.aborted) throw error; return { error: error.message }; }
}
module.exports = { schemas, execute, command, needsApproval, target, inside, preview };
