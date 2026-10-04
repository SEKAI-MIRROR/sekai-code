import { execFile } from 'node:child_process';
import os from 'node:os';
import {
 TuiAltScreen, ProcessTerminal, Container, Box, Spacer, Markdown, Text, Input,
 SelectList, CombinedAutocompleteProvider, matchesKey, truncateToWidth, visibleWidth,
} from '@earendil-works/pi-tui';
import terminalHelpers from './terminal.js';
import { CustomEditor } from './pi/custom-editor.mjs';
import { createChatViewport } from './pi/chat-viewport.mjs';
import { WorkingStatusIndicator } from './pi/status-indicator.mjs';
import { ink, fg, bg, markdownTheme, selectTheme } from './pi/theme.mjs';

const { clean } = terminalHelpers;
const space = () => new Spacer(1);
const fit = (text, width) => truncateToWidth(text, Math.max(1, width), '');
const shortNumber = value => value >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value || 0);

class UserMessage extends Markdown {
 constructor(text) {
  super(clean(text), 1, 1, markdownTheme, { color: fg('userMessageText'), bgColor: bg('userMessageBg') }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true });
 }
 render(width) { return ['', ...super.render(width)]; }
}

export class ToolCard {
 constructor(event) { this.event = event; this.expanded = false; this.result = null; }
 invalidate() {}
 finish(result) { this.result = result; }
 render(width) {
  const { name, args = {}, preview } = this.event;
  const r = this.result;
  const failed = r && (r.error || r.denied || r.cancelled || r.timedOut || (r.code != null && r.code !== 0));
  const background = failed ? 'toolErrorBg' : r ? 'toolSuccessBg' : 'toolPendingBg';
  const detail = clean(args.command || args.path || args.url || args.name || (args.args || []).join(' '));
  const label = ({ read_file: 'read', write_file: 'write', edit_file: 'edit', list_files: 'ls', run_command: 'bash' })[name] || name;
  const title = (this.event.agentName ? ink.dim(`[${clean(this.event.agentName)}] `) : '') + ink.bold(fg('toolTitle')(label)) + (detail ? ' ' + ink.accent(detail) : '');
  let output = preview ? clean(preview) : '';
  if (r) {
   const body = r.output ?? r.text ?? (r.agents ? r.agents.map(a => `${a.name}: ${a.status}\n${a.result || a.error || ''}`).join('\n\n') : r.id && r.status ? `${r.status} · ${r.id}` : r.entries ? r.entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') : '');
   output = [output, clean(body)].filter(Boolean).join('\n');
   const status = r.denied ? 'Permission denied' : r.error || (r.cancelled ? 'Cancelled' : r.timedOut ? 'Timed out' : r.code != null ? `exit ${r.code}` : r.bytes != null ? `${r.bytes} bytes written` : '');
   if (status) output += (output ? '\n' : '') + clean(status);
  }
  const lines = output ? output.split('\n') : [];
  const collapsed = !this.expanded && lines.length > 5;
  const shown = collapsed ? (name === 'run_command' ? lines.slice(-5) : lines.slice(0, 5)) : lines;
  const body = shown.map(line => {
   const paint = line.startsWith('+') ? fg('toolDiffAdded') : line.startsWith('-') ? fg('toolDiffRemoved') : fg('toolOutput');
   return paint(line.replaceAll('\t', '  '));
  });
  if (collapsed) body.push(ink.muted(`... (${lines.length - shown.length} more lines, ctrl+o to expand)`));
  const box = new Box(1, 1, bg(background));
  box.addChild(new Text([title, ...body].join('\n'), 0, 0));
  return ['', ...box.render(width).map(line => fit(line, width))];
 }
}

class ThinkingBlock extends Container {
 constructor(hidden) { super(); this.hidden = hidden; this.text = ''; }
 append(text) { this.text += text; this.rebuild(); }
 setHidden(hidden) { this.hidden = hidden; this.rebuild(); }
 rebuild() {
  this.clear();
  this.addChild(this.hidden ? new Text(ink.italic(fg('thinkingText')('Thinking...')), 1, 0) : new Markdown(this.text.trim(), 1, 0, markdownTheme, { color: fg('thinkingText'), italic: true }));
 }
}

class Footer {
 constructor(owner) { this.owner = owner; }
 invalidate() {}
 render(width) {
  const { options = {}, session = {}, branch } = this.owner;
  const home = os.homedir();
  const cwd = clean(session.cwd || process.cwd());
  const location = cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
  const usage = session.usage || {};
  const left = [usage.input ? `↑${shortNumber(usage.input)}` : '', usage.output ? `↓${shortNumber(usage.output)}` : '', !usage.input && !usage.output && session.tokens ? `${shortNumber(session.tokens)} tokens` : ''].filter(Boolean).join(' ');
  const right = `(${options.provider || 'sekai'}) ${options.model || 'no-model'}${options.effort ? ` • ${options.effort}` : ''}`;
  const gap = width - visibleWidth(left) - visibleWidth(clean(right));
  return [ink.muted(fit(`${location}${branch ? ` (${clean(branch)})` : ''}`, width)),
   ink.muted(fit(gap >= 2 ? left + ' '.repeat(gap) + clean(right) : `${left}  ${clean(right)}`, width))];
 }
}

class WelcomeHeader {
 constructor(owner) { this.owner = owner; }
 invalidate() {}
 render(width) {
  if (this.owner.transcript.children.length) return [''];
  const available = Math.max(0, width - 2);
  const mode = this.owner.options?.approval || 'ask';
  const labels = { ask: ['ASK', 'confirm actions'], auto: ['AUTO', 'file edits'], full: ['YOLO', 'auto-approve'] };
  const [label, detail] = labels[mode] || labels.ask;
  const badge = (mode === 'full' ? ink.yellow : ink.green)(width >= 64 ? `${label} · ${detail}` : label);
  const version = width >= 40 ? ` ${ink.dim(`v${clean(this.owner.version)}`)}` : '';
  const title = `${ink.accent('◇')} ${ink.bold(ink.accent('sekai'))}${version}`;
  const gap = available - visibleWidth(title) - visibleWidth(badge);
  const heading = gap >= 3 ? `${title} ${ink.dim('─'.repeat(gap - 2))} ${badge}` : title;
  const hints = width >= 72 ? '/help shortcuts · /model model · ctrl+j newline · esc stop'
   : width >= 40 ? '/help shortcuts · /model model' : '/help shortcuts';
  return [fit(` ${heading}`, width), fit(` ${ink.muted(hints)}`, width), ''];
 }
}

// An inline picker keeps approval context and the editor draft visible.
class Picker extends Container {
 constructor(title, items, done, { filter = false, current, approval = false, placeholder = 'Search models…' } = {}) {
  super(); this.filter = filter; this.approval = approval;
  this.addChild(new Text(ink.accent(clean(title)), 1, 0));
  this.input = new Input({ prompt: '  / ', placeholder, placeholderStyle: ink.muted });
  if (filter) this.addChild(this.input);
  this.items = items.map(item => ({ ...item, label: clean(item.label), description: clean(item.description || '') }));
  this.list = new SelectList(this.items, 8, selectTheme);
  this.list.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === current)));
  this.list.onSelect = item => done(item.value);
  this.list.onCancel = () => done(null);
  this.addChild(this.list);
  this.addChild(new Text(ink.muted(approval ? '  ↑↓ select · enter confirm · y allow once · n/esc deny' : '  ↑↓ select · enter confirm · esc cancel'), 0, 0));
  this.input.onSubmit = () => { const item = this.list.getSelectedItem(); if (item) done(item.value); };
  this.input.onEscape = () => done(null);
  this.done = done;
 }
 set focused(value) { if (this.input) this.input.focused = value; }
 get focused() { return this.input?.focused || false; }
 handleInput(data) {
  if (this.approval && (data === 'y' || data === 'Y')) return this.done('allow');
  if (this.approval && (data === 'n' || data === 'N')) return this.done(null);
  if (!this.filter || ['up', 'down', 'pageUp', 'pageDown'].some(key => matchesKey(data, key))) this.list.handleInput(data);
  else {
   const previous = this.input.getValue();
   this.input.handleInput(data);
   const query = this.input.getValue().toLowerCase();
   if (previous.toLowerCase() !== query) {
    const index = this.children.indexOf(this.list);
    this.list = new SelectList(this.items.filter(item => `${item.value} ${item.label} ${item.description}`.toLowerCase().includes(query)), 8, { ...selectTheme, noMatch: () => ink.muted('  No matches') });
    this.list.onSelect = item => this.done(item.value); this.list.onCancel = () => this.done(null);
    this.children[index] = this.list;
   }
  }
 }
}

export class RichTerminal {
 constructor({ terminal = new ProcessTerminal() } = {}) {
  this.rich = true; this.interactive = true; this.closed = false; this.busy = false;
  this.queue = []; this.cards = []; this.agentCards = new Map(); this.thinkingBlocks = []; this.hideThinking = false;
  this.device = terminal;
  this.tui = new TuiAltScreen(terminal, process.env.SEKAI_HARDWARE_CURSOR === '1', undefined, {
   wheelScrollLines: 'auto', copyOnSelect: false,
   scrollToEndIndicator: () => bg('selectedBg')(ink.text(' ↓ Jump to latest message · end ')),
  });
  this.transcript = new Container(); this.dialog = new Container(); this.header = new WelcomeHeader(this);
  this.editor = new CustomEditor(this.tui, { borderColor: fg('thinkingOff'), selectList: selectTheme }, { matches: () => false }, { paddingX: 0, autocompleteMaxVisible: 5, embedWorkingStatus: true });
  this.footer = new Footer(this);
  this.pendingMessages = new Container();
  this.document = new Container(); this.document.addChild(this.transcript);
  const viewport = createChatViewport({ document: this.document, pendingMessages: this.pendingMessages, status: this.dialog, widgetsAbove: this.header, editor: this.editor, footer: this.footer, scrollbarTrackStyle: fg('scrollbarTrack'), scrollbarThumbStyle: fg('scrollbarThumb') });
  this.scrollView = viewport.transcript;
  this.tui.setLayoutRoot(viewport.root);
  for (const component of [this.header, this.transcript, this.dialog, this.editor, this.footer]) this.tui.addChild(component);
  this.editor.onSubmit = text => {
   text = clean(text).trim(); if (!text || this.closed) return;
   this.editor.addToHistory(text); this.editor.setText('');
   if (this.busy && text === '/agents') {
    this.note(this.session?.subagents?.length ? this.session.subagents.map(a => `${a.name} · ${a.status} · ${a.tokens || 0} tokens\n  ${a.id}\n  ${a.task}`).join('\n\n') : 'No sub-agents in this session.');
    return;
   }
   if (this.pending) { const done = this.pending; this.pending = null; done(text); }
   else this.queue.push(text);
   this.updateQueue();
   this.tui.requestRender();
  };
  this.tui.addInputListener(data => this.handleKey(data));
  this.tui.setFocus(this.editor);
 }
 paint(text) { return text; }
 handleKey(data) {
  if (matchesKey(data, 'ctrl+t')) {
   this.hideThinking = !this.hideThinking;
   for (const block of this.thinkingBlocks) block.setHidden(this.hideThinking);
   this.tui.requestRender(); return { consume: true };
  }
  if (matchesKey(data, 'ctrl+o')) {
   this.expanded = !this.expanded;
   for (const card of this.cards) card.expanded = this.expanded;
   this.tui.requestRender(); return { consume: true };
  }
  if (matchesKey(data, 'ctrl+c')) {
   if (this.busy) { this.queue = []; this.updateQueue(); this.onInterrupt?.(); }
   else if (this.pickerDone) this.pickerDone(null);
   else if (this.editor.getText()) this.editor.setText('');
   else this.onInterrupt?.();
   this.tui.requestRender(); return { consume: true };
  }
  if (matchesKey(data, 'ctrl+d') && !this.editor.getText() && !this.pickerDone) {
   this.onInterrupt?.(); this.close(); return { consume: true };
  }
  if (matchesKey(data, 'escape') && this.busy && !this.pickerDone && !this.editor.isShowingAutocomplete()) {
   this.queue = []; this.updateQueue(); this.onInterrupt?.(); return { consume: true };
  }
 }
 syncContext(options, session) {
  this.options = options; this.session = session;
  if (this.projectCwd !== session.cwd) this.setProject(session.cwd);
  this.tui.requestRender();
 }
 banner(options, session, version) {
  this.version = version;
  this.syncContext(options, session);
  this.restore(session);
  this.tui.start(); this.startedUI = true;
 }
 setProject(cwd) {
  this.projectCwd = cwd; this.branch = undefined;
  this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
   { name: 'help', description: 'Show commands and keyboard shortcuts' },
   { name: 'model', description: 'Choose a model', argumentHint: '[id]' },
   { name: 'provider', description: 'Switch provider', getArgumentCompletions: prefix => ['sekai', 'openai', 'anthropic', 'deepseek'].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })) },
   { name: 'permissions', description: 'Set approval mode', getArgumentCompletions: prefix => ['ask', 'auto', 'full'].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })) },
   { name: 'status', description: 'Project, model, and session details' },
   { name: 'agents', description: 'Sub-agent tasks, statuses, and IDs' },
   { name: 'diff', description: 'Review Git changes' },
   { name: 'new', description: 'Start a new conversation' },
   { name: 'resume', description: 'Continue a saved conversation', argumentHint: '[id|latest]' },
   { name: 'exit', description: 'Save and exit' },
   { name: 'q', description: 'Save and exit' },
  ], cwd));
  execFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, timeout: 2000 }, (error, stdout) => {
   if (this.projectCwd !== cwd) return;
   if (!error) this.branch = clean(stdout.trim());
   if (!this.closed) this.tui.requestRender();
  });
 }
 restore(session) {
  const calls = new Map();
  for (const message of session.messages.slice(-80)) {
   if (message.internal) continue;
   if (message.role === 'user') { this.transcript.addChild(new UserMessage(message.content)); this.editor.addToHistory(message.content); }
   if (message.role === 'assistant') {
    if (message.content) { this.transcript.addChild(space()); this.transcript.addChild(new Markdown(clean(message.content), 1, 0, markdownTheme)); }
    for (const call of message.tool_calls || []) {
     let args = {}; try { args = JSON.parse(call.function.arguments); } catch { /* historical invalid arguments */ }
     const card = new ToolCard({ name: call.function.name, args });
     calls.set(call.id, card); this.cards.push(card); this.transcript.addChild(card);
    }
   }
   if (message.role === 'tool' && calls.has(message.tool_call_id)) {
    let result; try { result = JSON.parse(message.content); } catch { result = { output: message.content }; }
    calls.get(message.tool_call_id).finish(result);
   }
  }
  if (session.messages.length) this.note(`Resumed session ${session.id.slice(0, 8)} · ${session.messages.length} messages`);
 }
 reset(session) {
  this.session = session; this.transcript.clear(); this.cards = []; this.agentCards.clear(); this.thinkingBlocks = []; this.queue = [];
  this.assistant = null; this.reasoning = null; this.editor.setText('');
  this.updateQueue(); this.scrollView.scrollToEnd(); this.tui.requestRender();
 }
 ask() {
  if (this.closed) return Promise.resolve(null);
  if (this.queue.length) { const text = this.queue.shift(); this.updateQueue(); return Promise.resolve(text); }
  this.tui.setFocus(this.editor); this.tui.requestRender();
  return new Promise(resolve => { this.pending = resolve; });
 }
 cancelPrompt() {
  this.pickerDone?.(null);
  if (this.pending) { const done = this.pending; this.pending = null; done(null); }
 }
 select(title, items, current, { filter = true, approval = false, placeholder } = {}) {
  if (this.closed) return Promise.resolve(null);
  return new Promise(resolve => {
   const done = value => {
    if (this.pickerDone !== done) return;
    this.pickerDone = null; this.dialog.clear(); this.tui.setFocus(this.editor); this.tui.requestRender(); resolve(value);
   };
   this.pickerDone = done;
   const picker = new Picker(title, items, done, { filter, current, approval, placeholder });
   this.dialog.addChild(space()); this.dialog.addChild(picker); this.tui.setFocus(picker); this.tui.requestRender();
  });
 }
 async approve(action) {
  if (action.signal?.aborted || this.closed) return false;
  const card = this.cards.findLast(c => !c.result && c.event.name === action.name && c.event.agentId === action.agentId);
  if (card) card.expanded = true;
  const decision = this.select(`${action.agentName ? `[${clean(action.agentName)}] ` : ''}Allow ${clean(action.name)}?`, [
   { value: 'deny', label: 'Deny', description: 'Skip this action' },
   { value: 'allow', label: 'Allow once', description: 'Approve only this action' },
   { value: 'full', label: 'Auto-approve session', description: 'Enable full: all tools and workers without confirmation' },
  ], 'deny', { filter: false, approval: true });
  const done = this.pickerDone;
  const cancel = () => { if (this.pickerDone === done) done?.(null); };
  action.signal?.addEventListener('abort', cancel, { once: true });
  try {
   const selected = await decision;
   if (action.signal?.aborted || this.closed) return false;
   return selected === 'full' ? 'full' : selected === 'allow';
  }
  finally { action.signal?.removeEventListener('abort', cancel); if (card) card.expanded = !!this.expanded; this.tui.requestRender(); }
 }
 updateQueue() {
  this.pendingMessages.clear();
  if (this.queue.length) {
   this.pendingMessages.addChild(space());
   for (const text of this.queue) this.pendingMessages.addChild(new Text(ink.dim(`Follow-up: ${text.replaceAll('\n', ' ')}`), 1, 0));
  }
 }
 beginPrompt(text) {
  this.transcript.addChild(new UserMessage(text)); this.assistant = null; this.reasoning = null;
  this.busy = true;
  this.indicator?.dispose();
  this.indicator = new WorkingStatusIndicator(this.tui, this.editor.borderColor);
  this.editor.setWorkingStatusIndicator(this.indicator);
  this.scrollView.scrollToEnd(); this.tui.requestRender();
 }
 endTurn() {
  this.busy = false; this.indicator?.dispose(); this.indicator = null;
  this.editor.setWorkingStatusIndicator(undefined);
  for (const card of this.cards) if (!card.result) card.finish({ cancelled: true });
  this.tui.requestRender();
 }
 note(text) { this.transcript.addChild(new Text(ink.muted(clean(text)), 1, 1)); this.tui.requestRender(); }
 emit(event) {
  if (event.type === 'permission_mode') {
   this.note('Auto-approve enabled (full) for this CLI session. /permissions ask restores confirmations.');
   return;
  }
  if (event.type === 'subagent_start') {
   const card = new ToolCard({ name: 'agent', args: { name: event.agent.name }, preview: `${event.agent.task}\nRunning · ${event.model}` });
   card.task = event.agent.task;
   card.expanded = !!this.expanded; this.agentCards.set(event.agent.id, card); this.cards.push(card); this.transcript.addChild(card);
  }
  if (event.type === 'subagent_event') {
   const inner = event.event, card = this.agentCards.get(event.agent.id);
   if (card && ['request_start', 'tool_start'].includes(inner.type)) card.event.preview = `${card.task}\n${inner.type === 'tool_start' ? `Running ${inner.name}` : 'Thinking…'}`;
   if (['tool_start', 'tool_end'].includes(inner.type)) this.emit({ ...inner, agentId: event.agent.id, agentName: event.agent.name });
   this.tui.requestRender(); return;
  }
  if (event.type === 'subagent_end') {
   const card = this.agentCards.get(event.agent.id);
   if (card) {
    card.event.preview = `${event.agent.task}\n${event.agent.status} · ${event.agent.tokens} tokens`;
    card.finish({ output: event.agent.result || '', ...(event.agent.error ? { error: event.agent.error } : {}), ...(event.agent.status === 'cancelled' ? { cancelled: true } : {}) });
   }
   for (const pending of this.cards) if (!pending.result && pending.event.agentId === event.agent.id) pending.finish({ cancelled: true, ...(event.agent.error ? { error: event.agent.error } : {}) });
  }
  if (event.type === 'request_start') { this.assistant = null; this.reasoning = null; }
  if (event.type === 'content') {
   if (!this.assistant) { this.assistant = new Markdown('', 1, 0, markdownTheme); this.assistantText = ''; this.transcript.addChild(space()); this.transcript.addChild(this.assistant); }
   this.assistantText += clean(event.delta); this.assistant.setText(this.assistantText.trim());
  }
  if (event.type === 'reasoning') {
   if (!this.reasoning) { this.reasoning = new ThinkingBlock(this.hideThinking); this.thinkingBlocks.push(this.reasoning); this.transcript.addChild(space()); this.transcript.addChild(this.reasoning); }
   this.reasoning.append(clean(event.delta));
  }
  if (event.type === 'tool_start') {
   const card = new ToolCard(event); card.expanded = !!this.expanded; this.cards.push(card);
   this.transcript.addChild(card);
  }
  if (event.type === 'tool_end') {
   let card = this.cards.findLast(card => !card.result && card.event.name === event.name && card.event.agentId === event.agentId);
   if (!card) { card = new ToolCard({ name: event.name, agentId: event.agentId, agentName: event.agentName }); this.cards.push(card); this.transcript.addChild(card); }
   card.finish(event.result);
  }
  if (event.type === 'turn_end') this.endTurn();
  this.tui.requestRender();
 }
 close() {
  if (this.closed) return;
  this.closed = true; this.queue = []; this.cancelPrompt(); this.indicator?.dispose();
  // Pi otherwise prints the input dock after leaving the alternate screen.
  // preserveScreen restores the original shell without exporting any TUI rows.
  if (this.startedUI) this.tui.stop({ preserveScreen: true });
 }
}
