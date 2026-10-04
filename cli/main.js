#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const Config = require('./config');
const Providers = require('./providers');
const Gateway = require('./adapters/sekai');
const { promptKey } = require('./auth');
const { run } = require('./agent');
const { command } = require('./tools');
const { createTerminal, clean } = require('./terminal');
const { selectSession, prepareResume } = require('./resume');
const { version } = require('../package.json');
const HELP = `Sekai Code ${version} — a coding agent in your terminal

Usage:
  sekai [prompt]                  Open interactive chat
  sekai exec "task"                Run a task and exit
  sekai exec - < prompt.txt        Read a task from stdin
  sekai resume [id|latest]         Pick or continue a saved chat (TTY required)
  sekai sessions                  List saved chats
  sekai login                     Save an API key (hidden input)
  sekai login --key-stdin          Read an API key from stdin
  sekai logout                    Remove this provider's saved key
  sekai auth status               Show authentication status (no key)
  sekai models                    List provider models
  sekai config                    Show configuration (no keys)
  sekai config set <key> <value>   Set a default

Options:
  -C, --cwd <directory>            Project directory
  -p, --provider <name>            sekai (default), openai, anthropic, deepseek
  -m, --model <id>                 Model ID from sekai models
  -a, --approval <mode>            ask (default), auto, full
      --yolo                      Run all tools without confirmation (full mode)
      --base-url <url>            Override the selected provider's API base
      --effort <level>            Provider reasoning effort
      --max-turns <number>        Model calls per task (default 40)
      --max-agents <number>       Concurrent sub-agents, 0–8 (default 3)
      --json                      JSONL events in exec mode
      --no-color                  Disable ANSI styling
      --plain                     Use the simple readline interface
  -h, --help                      Show help
  -v, --version                   Show version

Setup (Node.js 22.19+):
  sekai login                     Or set SEKAI_API_KEY
  sekai models
  sekai

Default: Sekai Gateway at ${Gateway.BASE_URL}
Model: ${Gateway.DEFAULT_MODEL} (change with --model or config set model)

Permissions:
  ask   Read project files freely; approve writes, external reads, shell, Git, web.
  auto  Also allow file edits inside the project, excluding .git and .sekai.
  full  Allow all tools without asking. Commands have your OS permissions.
Approvals are an application policy, not an OS sandbox. Without a TTY,
requests needing approval are denied. Use auto for unattended project edits.

State: ~/.sekai (override with SEKAI_HOME). Sessions contain prompts and tool
output. Login keys are stored separately in credentials.json (0600, not encrypted).
Environment API keys override saved keys. Saved keys are bound to the API origin.
`;
const SLASH = `/help                    Show commands
/model [id]              Select or change model
/provider <name>         Switch provider and clear model selection
/permissions [mode]      Show or change ask / auto / full
/status                  Show project, provider, model and session
/agents                  Show sub-agent tasks, statuses and IDs
/diff                    Show unstaged and staged Git changes
/new                     Start a fresh conversation
/resume [id|latest]       Pick or continue a saved conversation
/q, /exit, /quit         Save and exit
Enter send · Shift+Enter / Ctrl+J newline · Tab complete
Ctrl+O expand tools · Ctrl+T thinking · PgUp/PgDn scroll · End latest
Esc stop · Ctrl+C clear/stop/exit · Ctrl+D exit
Type a follow-up while working; Enter queues it for the next turn.
In --plain mode, end a line with \\ to continue on another line.`;
async function stdinText() { let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 2 * 1024 * 1024) throw new Error('stdin exceeds 2 MiB.'); } return text; }
async function main(argv = process.argv.slice(2)) {
 const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, cwd: { type: 'string', short: 'C' }, provider: { type: 'string', short: 'p' }, model: { type: 'string', short: 'm' }, approval: { type: 'string', short: 'a' }, yolo: { type: 'boolean' }, 'base-url': { type: 'string' }, effort: { type: 'string' }, 'max-turns': { type: 'string' }, 'max-agents': { type: 'string' }, json: { type: 'boolean' }, 'no-color': { type: 'boolean' }, plain: { type: 'boolean' }, 'key-stdin': { type: 'boolean' },
 } });
 if (values.help) { process.stdout.write(HELP); return; }
 if (values.version) { process.stdout.write(`Sekai Code ${version}\n`); return; }
 if (values['no-color']) process.env.NO_COLOR = '1';
 let options = await Config.config();
 for (const [flag, key] of Object.entries({ provider: 'provider', model: 'model', approval: 'approval', 'base-url': 'baseUrl', effort: 'effort', 'max-turns': 'maxTurns', 'max-agents': 'maxAgents' })) if (values[flag] !== undefined) options[key] = values[flag];
 if (values.yolo) {
  if (values.approval !== undefined && values.approval !== 'full') throw new Error('--yolo cannot be combined with --approval other than full.');
  options.approval = 'full';
 }
 if (values.provider && values.provider !== (await Config.config()).provider) { if (!values.model) delete options.model; if (!values['base-url']) delete options.baseUrl; if (!values.effort) delete options.effort; }
 if (options.provider === 'sekai') options.model ||= Gateway.DEFAULT_MODEL;
 Config.validate(options);
 const known = ['exec', 'resume', 'sessions', 'models', 'config', 'login', 'logout', 'auth'];
 const action = known.includes(positionals[0]) ? positionals.shift() : 'chat';
 if (values.json && action !== 'exec') throw new Error('--json is supported by sekai exec.');
 if (values['key-stdin'] && action !== 'login') throw new Error('--key-stdin is only supported by sekai login.');
 if (action === 'login') {
  if (positionals.length) throw new Error('Use hidden input or --key-stdin; do not pass keys as command arguments.');
  const key = values['key-stdin'] ? (await stdinText()).trim() : await promptKey();
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('API key must be nonempty and contain no whitespace.');
  const found = await Providers.models(options, key, AbortSignal.timeout(30000));
  if (!found.length) throw new Error('Provider returned no available models. Key was not saved.');
  await Config.saveCredential(options, key);
  await Config.setConfig('provider', options.provider);
  if (options.baseUrl) await Config.setConfig('baseUrl', options.baseUrl);
  const model = found.some(m => m.id === options.model) ? options.model : found[0].id;
  await Config.setConfig('model', model);
  process.stdout.write(`Connected to ${options.provider === 'sekai' ? 'Sekai Gateway' : options.provider}. ${found.length} models available.\nDefault model: ${clean(model)}\n`);
  return;
 }
 if (action === 'logout') {
  if (positionals.length) throw new Error('Usage: sekai logout [--provider name]');
  await Config.removeCredential(options.provider);
  const status = Config.credentialStatus(options);
  process.stdout.write(`Saved ${options.provider} key removed.${status.connected ? ` ${status.source} is still set in your environment.` : ''}\n`);
  return;
 }
 if (action === 'auth') {
  if (positionals.join(' ') !== 'status') throw new Error('Usage: sekai auth status');
  const status = Config.credentialStatus(options);
  process.stdout.write(`${options.provider}: ${status.connected ? 'connected' : 'not connected'} (${status.source})\nEndpoint: ${options.baseUrl || Config.roots[options.provider]}\n`);
  return;
 }
 if (action === 'config') {
  if (positionals.length === 3 && positionals[0] === 'set') { await Config.setConfig(positionals[1], positionals[2]); process.stdout.write('Configuration saved.\n'); }
  else if (!positionals.length) process.stdout.write(JSON.stringify(await Config.config(), null, 2) + '\n');
  else throw new Error('Usage: sekai config [set <key> <value>]');
  return;
 }
 if (action === 'sessions') {
  const list = await Config.sessions();
  process.stdout.write(list.length ? list.map(s => `${s.id}  ${s.updated}  ${clean(s.title || '(empty)')}\n  ${clean(s.cwd)}`).join('\n') + '\n' : 'No saved sessions.\n'); return;
 }
 if (action === 'models') {
  const found = await Providers.models(options, Config.credentials(options), AbortSignal.timeout(30000));
  process.stdout.write(found.map(m => `${clean(m.id)}  ${clean(m.name)}`).join('\n') + '\n'); return;
 }
 const interactive = !!process.stdin.isTTY && !!process.stderr.isTTY && !values.json;
 if (action === 'resume' && !interactive) throw new Error('sekai resume requires an interactive terminal.');
 if (action === 'resume' && positionals.length > 1) throw new Error('Usage: sekai resume [id|latest]');
 let cwd = await fs.realpath(path.resolve(values.cwd || process.cwd()));
 if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd must be a directory.');
 let session;
 const fresh = () => ({ id: randomUUID(), cwd, provider: options.provider, model: options.model, messages: [], updated: new Date().toISOString() });
 if (action === 'resume' && positionals[0]) ({ session, options, cwd } = await prepareResume(positionals[0], { options, flags: values, cwd }));
 else session = fresh();
 let prompt = action === 'resume' ? '' : positionals.join(' ');
 if (!process.stdin.isTTY) { const piped = await stdinText(); prompt = [prompt === '-' ? '' : prompt, piped].filter(Boolean).join('\n\n').trim(); }
 if ((!interactive || action === 'exec') && !prompt) throw new Error('Provide a prompt: sekai exec "task" or pipe text into sekai exec -.');
 const terminal = await createTerminal({ json: !!values.json, interactive, rich: !values.plain && action !== 'exec' });
 let controller = null;
 const cancel = () => { if (controller) { controller.abort(); terminal.cancelPrompt(); } else { terminal.cancelPrompt(); terminal.close(); } };
 process.on('SIGINT', cancel); terminal.rl?.on('SIGINT', cancel);
 terminal.onInterrupt = cancel;
 const resume = async id => {
  id ||= await selectSession(terminal);
  if (!id || terminal.closed) return;
  const next = await prepareResume(id, { options, flags: values, cwd });
  if (terminal.closed) return;
  ({ session, options, cwd } = next);
  terminal.reset?.(session);
  terminal.syncContext?.(options, session);
  if (terminal.restore) terminal.restore(session);
  else terminal.note(`Resumed session ${session.id} · ${session.messages.length} messages\n${session.cwd}`);
 };
 const ensureModel = async (choose = false) => {
  if (options.model && !choose) return;
  const key = Config.credentials(options);
  const found = await Providers.models(options, key, AbortSignal.timeout(30000));
  if (!found.length) throw new Error('Provider returned no models. Pass --model explicitly.');
  if (!interactive) throw new Error('Select a model with --model <id> or sekai config set model <id>.');
  if (terminal.rich) {
   const choice = await terminal.select('Select model', found.map(m => ({ value: m.id, label: m.id, description: m.name === m.id ? '' : m.name })), options.model);
   if (choice) options.model = choice;
   return !!options.model;
  }
  terminal.note(found.map((m, i) => `  ${i + 1}. ${m.id}`).join('\n'));
  const choice = await terminal.ask('  Model number or ID: ');
  if (!choice?.trim()) throw new Error('No model selected.');
  options.model = found[Number(choice) - 1]?.id || choice.trim();
 };
 try {
  if (interactive) terminal.banner(options, session, version);
  if (action === 'resume' && !positionals[0]) await resume();
  while (!terminal.closed) {
   terminal.syncContext?.(options, session);
   if (!prompt) {
    if (!interactive || action === 'exec') break;
    prompt = await terminal.ask(terminal.paint('sekai › ', '1;36'));
    if (prompt === null) break;
    while (!terminal.rich && prompt.endsWith('\\')) { const line = await terminal.ask('      · '); if (line === null) break; prompt = prompt.slice(0, -1) + '\n' + line; }
   }
   prompt = prompt.trim(); if (!prompt) continue;
   if (prompt.startsWith('/') && interactive && action !== 'exec') {
    const [name, ...rest] = prompt.split(/\s+/); const value = rest.join(' '); prompt = '';
    if (['/q', '/exit', '/quit'].includes(name)) break;
    if (name === '/help') terminal.note(SLASH);
    else if (name === '/model') {
     if (value) options.model = value;
     else if (terminal.rich) { try { await ensureModel(true); } catch (error) { terminal.note(error.message); } }
     terminal.note(`Model: ${options.model || '(not selected)'}`);
    }
    else if (name === '/provider') {
     if (!Config.providers.includes(value)) terminal.note(`Choose ${Config.providers.join(', ')}`);
     else { options.provider = value; delete options.model; delete options.baseUrl; delete options.effort; if (value === 'sekai') options.model = Gateway.DEFAULT_MODEL; terminal.note(`Provider: ${value}. ${options.model ? `Model: ${options.model}` : 'Choose a model with /model.'}`); }
    } else if (name === '/permissions') {
     if (value && !Config.modes.includes(value)) terminal.note('Choose ask, auto, or full.');
     else { if (value) options.approval = value; terminal.note(`Approvals: ${options.approval}${options.approval === 'full' ? ' — tools run with your OS permissions' : ''}`); }
    } else if (name === '/status') terminal.note(`${options.provider} / ${options.model || '(no model)'}\n${cwd}\nSession: ${session.id}\nApprovals: ${options.approval}\nTokens: ${session.tokens || 0}`);
    else if (name === '/agents') terminal.note(session.subagents?.length ? session.subagents.map(a => `${a.name} · ${a.status === 'running' ? 'interrupted' : a.status} · ${a.tokens || 0} tokens\n  ${a.id}\n  ${a.task}`).join('\n\n') : 'No sub-agents in this session. Ask Sekai to delegate independent tasks.');
    else if (name === '/new') { session = fresh(); terminal.reset?.(session); terminal.note(`New session: ${session.id}`); }
    else if (name === '/resume') {
     try { await resume(value); } catch (error) { terminal.note(error.message); }
    }
    else if (name === '/diff') {
     controller = new AbortController();
     try { for (const args of [[], ['--cached']]) { const diff = await command('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', ...args], cwd, controller.signal, 30); terminal.note(diff.output || 'No changes.'); } }
     finally { controller = null; }
    } else terminal.note('Unknown command. Type /help.');
    continue;
   }
   try {
    await ensureModel();
    if (terminal.closed) break;
    if (!options.model) { prompt = ''; continue; }
    const key = Config.credentials(options);
    session.provider = options.provider; session.model = options.model;
    terminal.beginPrompt?.(prompt);
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(new Error('Turn exceeded 30 minutes. Resume to continue.')), 30 * 60 * 1000);
    try { await run({ session, options, key, prompt, signal: controller.signal, approve: action => terminal.approve(action), emit: event => terminal.emit(event) }); }
    finally { clearTimeout(timer); }
   } catch (error) {
    const aborted = controller?.signal.aborted;
    const message = aborted ? 'Stopped. Session saved.' : error.message;
    if (values.json) terminal.emit({ type: 'error', message, session: session.id }); else terminal.note(`\n${message}`);
    if (!interactive || action === 'exec') { process.exitCode = aborted ? 130 : 1; break; }
   } finally { controller = null; terminal.endTurn?.(); }
   prompt = '';
   if (action === 'exec' || !interactive) break;
  }
 } finally { terminal.close(); process.removeListener('SIGINT', cancel); }
}
if (require.main === module) main().catch(error => {
 if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
 else process.stderr.write(`sekai: ${clean(error.message)}\n`);
 process.exitCode = 1;
});
module.exports = { main };
