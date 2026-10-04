'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const entry = path.resolve(__dirname, '../cli/main.js');
function cli(args, env = {}, input = '') {
 return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
  child.on('error', reject); child.on('close', code => resolve({ code, out, err })); child.stdin.end(input);
 });
}
async function fixture(t, provider = 'openai') {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sekai-cli-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 await fs.mkdir(path.join(root, 'state'));
 await fs.writeFile(path.join(root, 'state', 'config.json'), JSON.stringify({ provider }));
 return { root, env: { SEKAI_API_KEY: '', SEKAI_HOME: path.join(root, 'state'), OPENAI_API_KEY: 'test-key', DEEPSEEK_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key' } };
}
async function server(t, handler) {
 const s = http.createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk;
  handler(req, res, data ? JSON.parse(data) : null);
 });
 await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
 t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
 return `http://127.0.0.1:${s.address().port}`;
}
const send = (res, events) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const event of events) res.write(`${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`); res.end(); };
test('help/version and invalid options work without credentials or Electron', async t => {
 const { env } = await fixture(t);
 assert.match((await cli(['--help'], env)).out, /Sekai Code/);
 assert.match((await cli(['--help'], env)).out, /--yolo/);
 assert.match((await cli(['--version'], env)).out, /1\.3\.0/);
 assert.equal((await cli(['--unknown'], env)).code, 1);
 assert.equal((await cli(['exec', 'test', '--approval', 'oops'], env)).code, 1);
 assert.equal((await cli(['exec', 'test', '--max-agents', '9'], env)).code, 1);
 assert.equal((await cli(['config', 'set', 'maxAgents', '-1'], env)).code, 1);
});
test('--yolo runs commands without confirmation and leaves saved permissions unchanged', async t => {
 const { root, env } = await fixture(t);
 const configFile = path.join(env.SEKAI_HOME, 'config.json');
 await fs.writeFile(configFile, JSON.stringify({ provider: 'openai', approval: 'ask' }));
 const before = await fs.readFile(configFile, 'utf8');
 let calls = 0;
 const base = await server(t, (req, res, body) => {
  calls++;
  if (calls % 2) send(res, [
   { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'shell', name: 'run_command', arguments: JSON.stringify({ command: 'echo yolo-approved' }) } },
   { type: 'response.completed', response: {} },
  ]);
  else {
   const result = JSON.parse(body.input.find(item => item.type === 'function_call_output' && item.call_id === 'shell').output);
   assert.equal(result.code, 0); assert.match(result.output, /yolo-approved/);
   send(res, [{ type: 'response.completed', response: {} }]);
  }
 });
 for (const flags of [['--yolo'], ['--yolo', '--approval', 'full']]) {
  const result = await cli(['exec', 'Run a command', '-C', root, '-m', 'test', '--base-url', base, '--json', ...flags], env);
  assert.equal(result.code, 0, result.out + result.err);
  const events = result.out.trim().split('\n').map(JSON.parse);
  assert(events.some(e => e.type === 'tool_end' && e.name === 'run_command' && e.result.code === 0));
  assert.equal(await fs.readFile(configFile, 'utf8'), before);
 }
 assert.equal(calls, 4);
});
test('--yolo rejects conflicting explicit approval modes in either argument order', async t => {
 const { env } = await fixture(t);
 for (const mode of ['ask', 'auto', 'oops']) {
  for (const flags of [['--yolo', '--approval', mode], ['-a', mode, '--yolo']]) {
   const result = await cli(['exec', 'Run', ...flags], env);
   assert.equal(result.code, 1);
   assert.match(result.err, /--yolo cannot be combined/);
  }
 }
});
test('OpenAI exec streams tool calls, creates file, persists resumable session and emits JSONL', async t => {
 const { root, env } = await fixture(t); let calls = 0;
 const base = await server(t, (req, res, body) => {
  assert.equal(req.url, '/responses'); calls++;
  if (calls === 1) send(res, [
   { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'one', name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'Sekai works\n' }) } },
   { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]);
  else {
   assert(body.input.some(item => item.type === 'function_call_output' && JSON.parse(item.output).created));
   send(res, [
    { type: 'response.output_text.delta', item_id: 'reply', delta: 'File created.' },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'File created.' }] } },
    { type: 'response.completed', response: { usage: { total_tokens: 8 } } },
   ]);
  }
 });
 const result = await cli(['exec', '-', '-C', root, '-m', 'test-model', '--base-url', base, '-a', 'auto', '--json'], env, 'Create hello.txt');
 assert.equal(result.code, 0, result.out + result.err);
 const events = result.out.trim().split('\n').map(JSON.parse);
 assert(events.some(e => e.type === 'content' && e.delta === 'File created.'));
 assert.equal(events.at(-1).type, 'turn_end');
 assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'Sekai works\n');
 const files = await fs.readdir(path.join(env.SEKAI_HOME, 'sessions'));
 const saved = await fs.readFile(path.join(env.SEKAI_HOME, 'sessions', files[0]), 'utf8');
 assert(!saved.includes('test-key')); assert.equal(JSON.parse(saved).messages.length, 4);
 assert.match((await cli(['sessions'], env)).out, /Create hello.txt/);
});
test('noninteractive ask denies tool writes and records refusal', async t => {
 const { root, env } = await fixture(t); let calls = 0;
 const base = await server(t, (req, res, body) => {
  if (!calls++) send(res, [
   { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'x', name: 'write_file', arguments: '{"path":"blocked","content":"x"}' } },
   { type: 'response.completed', response: {} },
  ]);
  else { assert(body.input.some(x => x.type === 'function_call_output' && JSON.parse(x.output).denied)); send(res, [{ type: 'response.completed', response: {} }]); }
 });
 const result = await cli(['exec', 'write', '-C', root, '-m', 'test', '--base-url', base, '--json'], env);
 assert.equal(result.code, 0, result.out); assert.match(result.out, /"denied":true/);
 await assert.rejects(fs.access(path.join(root, 'blocked')));
});
test('DeepSeek streams fragmented tool arguments and preserves reasoning for the next call', async t => {
 const { root, env } = await fixture(t); let calls = 0;
 const base = await server(t, (req, res, body) => {
  assert.equal(req.url, '/chat/completions');
  if (!calls++) send(res, [
   { choices: [{ delta: { reasoning_content: 'plan', tool_calls: [{ index: 0, id: 'd1', function: { name: 'list_files', arguments: '{"path":' } }] } }] },
   { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] }, finish_reason: 'tool_calls' }] },
  ]);
  else { assert(body.messages.some(m => m.reasoning_content === 'plan')); send(res, [{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }]); }
 });
 const result = await cli(['exec', 'list', '-C', root, '-p', 'deepseek', '-m', 'test', '--base-url', base], env);
 assert.equal(result.code, 0, result.err); assert.equal(result.out, 'Done\n');
});
test('provider errors and truncated streams fail with useful JSON errors', async t => {
 const { env } = await fixture(t);
 const base = await server(t, (req, res) => { res.writeHead(401); res.end('{"error":{"message":"Invalid key"}}'); });
 const result = await cli(['exec', 'test', '-m', 'test', '--base-url', base, '--json'], env);
 assert.equal(result.code, 1); assert.match(result.out, /Invalid key/);
 const truncated = await server(t, (req, res) => send(res, [{ type: 'response.output_text.delta', delta: 'partial' }]));
 assert.equal((await cli(['exec', 'test', '-m', 'test', '--base-url', truncated], env)).code, 1);
});
test('configuration rejects secrets and session path traversal', async t => {
 const { env } = await fixture(t);
 assert.equal((await cli(['config', 'set', 'apiKey', 'secret'], env)).code, 1);
 assert.equal((await cli(['config', 'set', 'model', 'example'], env)).code, 0);
 assert.match((await cli(['config'], env)).out, /example/);
 const { loadSession } = require('../cli/config');
 await assert.rejects(loadSession('../../etc/passwd'), /Invalid session/);
});
test('Anthropic adapter streams tool input and completes the tool loop through its SDK', async t => {
 const { root, env } = await fixture(t); let calls = 0;
 const base = await server(t, (req, res, body) => {
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'test-key');
  calls++;
  const head = { type: 'message_start', message: { id: `msg-${calls}`, type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
  if (calls === 1) send(res, [head,
   { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a1', name: 'list_files', input: {} } },
   { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"."}' } },
   { type: 'content_block_stop', index: 0 },
   { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
   { type: 'message_stop' },
  ]);
  else {
   assert(body.messages.some(m => m.content.some(c => c.type === 'tool_result')));
   send(res, [head,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listed.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
   ]);
  }
 });
 const result = await cli(['exec', 'list', '-C', root, '-p', 'anthropic', '-m', 'test', '--base-url', base], env);
 assert.equal(result.code, 0, result.err); assert.equal(result.out, 'Listed.\n'); assert.equal(calls, 2);
});
test('Sekai is the default provider; login stores a separate origin-bound key and logout removes it', async t => {
 const { root, env } = await fixture(t, 'sekai');
 await fs.rm(path.join(env.SEKAI_HOME, 'config.json'));
 const defaults = JSON.parse((await cli(['config'], env)).out);
 assert.equal(defaults.provider, 'sekai'); assert.equal(defaults.model, 'cx/gpt-5.6-sol');
 const base = await server(t, (req, res) => {
  assert.equal(req.url, '/v2/models');
  assert.equal(req.headers.authorization, 'Bearer local-secret');
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'cx/gpt-5.6-sol' }, { id: 'ds/deepseek-v4-flash' }] }));
 });
 const login = await cli(['login', '--key-stdin', '--base-url', `${base}/v2`], env, 'local-secret\n');
 assert.equal(login.code, 0, login.err); assert.match(login.out, /Sekai Gateway/); assert(!login.out.includes('local-secret'));
 const credentials = JSON.parse(await fs.readFile(path.join(env.SEKAI_HOME, 'credentials.json'), 'utf8'));
 assert.equal(credentials.sekai.key, 'local-secret'); assert.equal(credentials.sekai.origin, base);
 if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(env.SEKAI_HOME, 'credentials.json'))).mode & 0o777, 0o600);
 assert(!(await cli(['config'], env)).out.includes('local-secret'));
 const status = await cli(['auth', 'status'], env); assert.match(status.out, /connected/); assert(!status.out.includes('local-secret'));
 assert.match((await cli(['models'], env)).out, /ds\/deepseek/);
 const refused = await cli(['models', '--base-url', 'https://different.invalid/v2'], env);
 assert.equal(refused.code, 1); assert.match(refused.err, /different endpoint/);
 assert.equal((await cli(['logout'], env)).code, 0);
 assert.match((await cli(['auth', 'status'], env)).out, /not connected/);
 assert(!JSON.stringify(JSON.parse(await fs.readFile(path.join(env.SEKAI_HOME, 'credentials.json'), 'utf8'))).includes('local-secret'));
});
test('Sekai Gateway streams tools and reasoning through Chat Completions without DeepSeek-specific options', async t => {
 const { root, env } = await fixture(t, 'sekai'); let calls = 0;
 const base = await server(t, (req, res, body) => {
  assert.equal(req.url, '/v2/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer gateway-test');
  assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.model, 'cx/gpt-5.6-sol');
  if (!calls++) send(res, [
   { choices: [{ delta: { reasoning_content: 'plan', tool_calls: [{ index: 0, id: 's1', function: { name: 'write_file', arguments: '{"path":"hello.txt",' } }] } }] },
   { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hello"}' } }] }, finish_reason: 'tool_calls' }] },
  ]);
  else {
   assert(body.messages.some(m => m.reasoning_content === 'plan'));
   assert(!body.messages.some(m => m.native));
   assert(body.messages.some(m => m.role === 'tool' && JSON.parse(m.content).created));
   send(res, [{ choices: [{ delta: { content: 'Gateway works.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } }]);
  }
 });
 const result = await cli(['exec', 'write hello', '-C', root, '--base-url', `${base}/v2`, '-a', 'auto', '--json'], { ...env, SEKAI_API_KEY: 'gateway-test' });
 assert.equal(result.code, 0, result.out + result.err);
 const events = result.out.trim().split('\n').map(JSON.parse);
 assert.equal(events.at(-1).tokens, 15);
 assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello');
 assert.equal(calls, 2);
});
test('failed gateway login keeps existing credentials and does not leak the key', async t => {
 const { env } = await fixture(t, 'sekai');
 const file = path.join(env.SEKAI_HOME, 'credentials.json');
 const saved = { sekai: { key: 'old-key', origin: 'https://api.sekaigateway.xyz' } };
 await fs.writeFile(file, JSON.stringify(saved));
 const base = await server(t, (req, res) => { res.writeHead(401); res.end('{"error":{"message":"Invalid key new-secret"}}'); });
 const result = await cli(['login', '--key-stdin', '--base-url', base], env, 'new-secret');
 assert.equal(result.code, 1); assert(!result.err.includes('new-secret'));
 assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
});
test('Sekai Gateway exec delegates to two workers, saves separate sessions and keeps latest on the parent', async t => {
 const { root, env } = await fixture(t, 'sekai');
 let parentCalls = 0; const childCalls = new Map();
 const base = await server(t, (req, res, body) => {
  assert.equal(req.url, '/v2/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer worker-test-key');
  const worker = /You are sub-agent (Alpha|Beta)\./.exec(body.messages[0].content)?.[1];
  const toolCall = (name, args, index = 0) => ({ index, id: `${worker || 'parent'}-${name}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  let delta, reason = 'stop';
  if (!worker) {
   parentCalls++;
   if (parentCalls === 1) { delta = { tool_calls: ['Alpha', 'Beta'].map((name, index) => toolCall('spawn_agent', { name, task: `Create ${name}.txt containing your name.` }, index)) }; reason = 'tool_calls'; }
   else if (parentCalls === 2) { delta = { tool_calls: [toolCall('wait_agents', {})] }; reason = 'tool_calls'; }
   else {
    const reports = JSON.parse(body.messages.at(-1).content).agents;
    assert.equal(reports.length, 2); assert(reports.every(a => a.status === 'completed'));
    delta = { content: 'Both delegated tasks finished.' };
   }
  } else {
   assert(!body.tools.some(t => t.function.name === 'spawn_agent'));
   const count = (childCalls.get(worker) || 0) + 1; childCalls.set(worker, count);
   if (count === 1) { delta = { tool_calls: [toolCall('write_file', { path: `${worker}.txt`, content: worker })] }; reason = 'tool_calls'; }
   else { assert(JSON.parse(body.messages.at(-1).content).created); delta = { content: `${worker} file created.` }; }
  }
  send(res, [{ choices: [{ delta, finish_reason: reason }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]);
 });
 const result = await cli(['exec', 'Delegate creation of Alpha.txt and Beta.txt.', '-C', root, '--base-url', `${base}/v2`, '-a', 'auto', '--max-agents', '2', '--json'], { ...env, SEKAI_API_KEY: 'worker-test-key' });
 assert.equal(result.code, 0, result.out + result.err);
 assert.equal(await fs.readFile(path.join(root, 'Alpha.txt'), 'utf8'), 'Alpha');
 assert.equal(await fs.readFile(path.join(root, 'Beta.txt'), 'utf8'), 'Beta');
 const events = result.out.trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e => e.type === 'subagent_start').length, 2);
 assert.equal(events.filter(e => e.type === 'subagent_end' && e.agent.status === 'completed').length, 2);
 assert.equal(events.at(-1).tokens, 35);
 assert(!result.out.includes('worker-test-key'));
 const sessionsDir = path.join(env.SEKAI_HOME, 'sessions');
 const stored = await Promise.all((await fs.readdir(sessionsDir)).map(async name => JSON.parse(await fs.readFile(path.join(sessionsDir, name), 'utf8'))));
 const parent = stored.find(s => !s.parentId), children = stored.filter(s => s.parentId);
 assert.equal(children.length, 2); assert(children.every(s => s.parentId === parent.id));
 // Even if a child is newer, sessions/latest must keep pointing to the root chat.
 children[0].updated = '2099-01-01T00:00:00.000Z';
 await fs.writeFile(path.join(sessionsDir, children[0].id + '.json'), JSON.stringify(children[0]));
 const listed = await cli(['sessions'], env);
 assert.match(listed.out, new RegExp(parent.id)); assert(!listed.out.includes(children[0].id));
 const { execFile } = require('node:child_process');
 const latest = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', "require('./cli/config').loadSession('latest').then(s=>console.log(s.id))"], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ...env } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
 assert.equal(latest, parent.id);
 assert(!JSON.stringify(stored).includes('worker-test-key'));
});
