'use strict';
const readline = require('node:readline');
const { stripVTControlCharacters } = require('node:util');
// Remove escape/control bytes from untrusted text before it reaches the terminal.
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
class Terminal {
 constructor({ json = false, interactive = false } = {}) {
  this.json = json; this.interactive = interactive; this.streaming = false;
  this.color = !!process.stderr.isTTY && !process.env.NO_COLOR;
  this.closed = false;
  if (interactive) {
   this.rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
   this.rl.on('close', () => { this.closed = true; this.pending?.(null); this.pending = null; });
   this.rl.on('line', line => { const done = this.pending; this.pending = null; done?.(line); });
  }
 }
 paint(text, color = 36) { return this.color ? `\x1b[${color}m${text}\x1b[0m` : text; }
 note(text) { this.endStream(); process.stderr.write(clean(text) + '\n'); }
 endStream() { this.stopWorking(); if (this.streaming) { process.stdout.write('\n'); this.streaming = false; } }
 startWorking() {
  if (!this.interactive || this.json || !this.color) return;
  this.endStream();
  const frames = ['◰', '◳', '◲', '◱']; let frame = 0;
  this.spinner = setInterval(() => process.stderr.write(`\r\x1b[2K  ${this.paint(frames[frame++ % frames.length])} Working…`), 120);
  this.spinner.unref();
 }
 stopWorking() { if (this.spinner) { clearInterval(this.spinner); this.spinner = null; process.stderr.write('\r\x1b[2K'); } }
 banner(options, session, version) {
  const lines = [this.paint('  ◇  SEKAI CODE', '1;36') + `  v${version}`, '  Your project. Your terminal.', '', `  ${clean(options.provider)} / ${clean(options.model || 'choose a model with /model')}`, `  ${clean(session.cwd)}`, `  approvals: ${options.approval}  ·  session: ${session.id.slice(0, 8)}`, '', '  /help commands   /diff changes   Ctrl+C stop   Ctrl+D exit', ''];
  process.stderr.write('\n' + lines.join('\n') + '\n');
 }
 ask(label) {
  if (!this.rl || this.closed) return Promise.resolve(null);
  this.endStream();
  return new Promise(resolve => { this.pending = resolve; this.rl.setPrompt(label); this.rl.prompt(); });
 }
 cancelPrompt() { if (this.pending) { const done = this.pending; this.pending = null; process.stderr.write('\n'); done(null); } }
 async approve(action) {
  if (!this.interactive || this.closed || action.signal?.aborted) return false;
  const cancel = () => this.cancelPrompt();
  action.signal?.addEventListener('abort', cancel, { once: true });
  try {
   const response = await this.ask(this.paint(`  ${action.agentName ? `[${clean(action.agentName)}] ` : ''}Allow ${action.name}? [y/N/full = auto-approve all tools and workers this session] `, 33));
   if (action.signal?.aborted || this.closed) return false;
   const decision = response?.trim() || '';
   return /^full$/i.test(decision) ? 'full' : /^y(es)?$/i.test(decision);
  } finally { action.signal?.removeEventListener('abort', cancel); }
 }
 emit(event) {
  if (this.json) { process.stdout.write(JSON.stringify(event) + '\n'); return; }
  if (event.type === 'permission_mode') { this.note('Auto-approve enabled (full) for this CLI session. /permissions ask restores confirmations.'); return; }
  if (event.type === 'subagent_start') { this.note(`\n  Agent ${event.agent.name} started: ${event.agent.task}`); return; }
  if (event.type === 'subagent_end') { this.note(`  Agent ${event.agent.name}: ${event.agent.status} · ${event.agent.tokens} tokens${event.agent.error ? ` · ${event.agent.error}` : ''}`); return; }
  if (event.type === 'subagent_event') {
   if (['tool_start', 'tool_end'].includes(event.event.type)) this.emit({ ...event.event, agentName: event.agent.name });
   return;
  }
  if (event.type === 'request_start') this.startWorking();
  if (event.type === 'request_end') this.stopWorking();
  if (event.type === 'content') { this.stopWorking(); process.stdout.write(clean(event.delta)); this.streaming = true; }
  if (event.type === 'tool_start') {
   this.endStream();
   const detail = event.args.command || event.args.path || event.args.url || event.args.name || (event.args.args || []).join(' ');
   process.stderr.write(this.paint(`\n  › ${event.agentName ? `[${clean(event.agentName)}] ` : ''}${clean(event.name)}`, 36) + ` ${clean(detail)}\n`);
   if (event.preview) this.note(event.preview);
  }
  if (event.type === 'tool_end') {
   const result = event.result;
   const status = result.denied ? 'denied' : result.error ? result.error : result.timedOut ? 'timed out' : result.code != null ? `exit ${result.code}` : 'done';
   this.note(`  ${status}`);
   if (result.output) this.note(result.output.slice(-4000));
  }
  if (event.type === 'turn_end') { this.endStream(); if (this.interactive) this.note(`\n  ${event.tokens.toLocaleString()} tokens across this session\n`); }
 }
 close() {
  if (this.closed) return;
  this.endStream(); this.rl?.close(); this.closed = true;
 }
}
async function createTerminal(options) {
 if (options.rich && options.interactive && process.stdout.isTTY && process.env.TERM !== 'dumb') {
  const { RichTerminal } = await import('./tui.mjs');
  return new RichTerminal(options);
 }
 return new Terminal(options);
}
module.exports = { Terminal, clean, createTerminal };
