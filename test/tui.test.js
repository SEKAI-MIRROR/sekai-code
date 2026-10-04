'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripVTControlCharacters: strip } = require('node:util');
const path = require('node:path');

class FakeTerminal {
 columns = 100; rows = 35; kittyProtocolActive = false; output = ''; stopped = false;
 start(onInput, onResize) { this.input = onInput; this.resize = onResize; }
 stop() { this.stopped = true; }
 write(data) { this.output += data; }
 hideCursor() {} showCursor() {} moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
async function fixture(t) {
 const { RichTerminal } = await import('../cli/tui.mjs');
 const device = new FakeTerminal(); const ui = new RichTerminal({ terminal: device });
 const session = { id: 'test-session', cwd: path.resolve(__dirname, '..'), tokens: 42, messages: [] };
 ui.banner({ provider: 'sekai', model: 'test-model', approval: 'ask' }, session, 'test');
 t.after(() => ui.close());
 return { ui, device, session };
}
const documentLines = (ui, width) => [ui.document, ui.dialog, ui.header, ui.editor, ui.footer].flatMap(c => c.render(width));
const rendered = (ui, width = 100) => strip(documentLines(ui, width).join('\n'));

test('restoring rejected tool arguments does not crash the TUI', async t => {
 const { ui, session } = await fixture(t);
 session.messages = [
  { role: 'assistant', content: '', tool_calls: [
   { id: 'null', function: { name: 'list_files', arguments: 'null' } },
   { id: 'git', function: { name: 'git', arguments: '{"args":"status"}' } },
  ] },
  { role: 'tool', tool_call_id: 'null', content: '{"error":"Arguments must be an object."}' },
  { role: 'tool', tool_call_id: 'git', content: '{"error":"args must be an array."}' },
 ];
 ui.restore(session);
 assert.match(rendered(ui), /Arguments must be an object/);
 assert.match(rendered(ui), /args must be an array/);
});

test('welcome stays compact beside the editor, adapts to width, and shows current permissions', async t => {
 const { ui, device, session } = await fixture(t);
 const { visibleWidth } = await import('@earendil-works/pi-tui');
 for (const [mode, label] of [['ask', 'ASK'], ['auto', 'AUTO'], ['full', 'YOLO']]) {
  ui.syncContext({ ...ui.options, approval: mode }, session);
  for (const width of [100, 48, 24, 12]) {
   device.columns = width; device.resize(); ui.tui.renderNow();
   const lines = ui.header.render(width);
   assert.equal(lines.length, 3);
   assert(lines.every(line => visibleWidth(line) <= width));
   if (width >= 24) assert.match(strip(lines[0]), new RegExp(label));
   if (width >= 40) assert.match(strip(lines[0]), /vtest/);
   const screen = ui.tui.getScreenLines().map(strip);
   const heading = screen.findIndex(line => line.includes('◇ sekai'));
   assert.equal(heading, device.rows - 8, 'Welcome must sit directly above the input dock');
   assert.match(screen[heading + 1], /\/help/);
  }
 }
 device.columns = 100; device.resize(); ui.tui.renderNow();
 const editorRow = device.rows - 5;
 assert.match(strip(ui.tui.getScreenLines()[editorRow]), /─/);
 ui.beginPrompt('Start working'); ui.tui.renderNow();
 assert(!ui.tui.getScreenLines().some(line => strip(line).includes('◇ sekai')));
 assert.match(strip(ui.tui.getScreenLines()[editorRow]), /Working/);
});

test('TUI streams Markdown, renders tools safely, and stays within resized terminal width', async t => {
 const { ui, device } = await fixture(t);
 const { visibleWidth } = await import('@earendil-works/pi-tui');
 ui.beginPrompt('Inspect 日本語 👩‍💻 and fix the bug');
 ui.emit({ type: 'request_start' });
 ui.emit({ type: 'content', delta: '**Result**\n\n```js\nconst ready = true;\n```\n' });
 ui.emit({ type: 'tool_start', name: 'run_command', args: { command: 'npm test' } });
 ui.emit({ type: 'tool_end', name: 'run_command', result: { code: 0, output: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\x1b]52;c;SECRET\x07' } });
 let text = rendered(ui);
 assert.match(text, /Result/); assert(!text.includes('**Result**'));
 assert.match(text, /ctrl\+o to expand/); assert(!text.includes('line 0\n')); assert(!text.includes('SECRET'));
 device.input('\x0f');
 assert.match(rendered(ui), /line 0/);
 for (const width of [100, 48, 24, 12]) {
  device.columns = width; device.resize();
  for (const line of documentLines(ui, width)) assert(visibleWidth(line) <= width, `overflow at ${width}: ${strip(line)}`);
  ui.tui.renderNow();
 }
 ui.endTurn(); ui.close(); assert(device.stopped);
});

test('multiline editor submits intact, queues follow-ups, and interrupt clears queue', async t => {
 const { ui, device } = await fixture(t);
 const prompt = ui.ask();
 device.input('first line'); device.input('\n'); device.input('second line'); device.input('\r');
 assert.equal(await prompt, 'first line\nsecond line');
 ui.beginPrompt('first line\nsecond line');
 device.input('next task'); device.input('\r');
 assert.equal(ui.queue.length, 1);
 ui.endTurn(); assert.equal(await ui.ask(), 'next task');
 ui.beginPrompt('next task'); device.input('do not run'); device.input('\r');
 let aborted = false; ui.onInterrupt = () => { aborted = true; ui.cancelPrompt(); };
 device.input('\x1b'); assert(aborted); assert.equal(ui.queue.length, 0);
 ui.endTurn(); device.input('draft'); device.input('\x03'); assert.equal(ui.editor.getText(), '');
});

test('approval defaults to deny, supports allow once, and preserves prompt draft', async t => {
 const { ui, device } = await fixture(t);
 ui.beginPrompt('change a file'); device.input('my follow-up draft');
 const event = { type: 'tool_start', name: 'write_file', args: { path: 'hello.js' }, preview: '-old\n+new' };
 ui.emit(event);
 let approval = ui.approve(event);
 assert.match(rendered(ui), /Allow once/); assert.match(rendered(ui), /\+new/);
 device.input('\r'); assert.equal(await approval, false);
 assert.equal(ui.editor.getText(), 'my follow-up draft');
 approval = ui.approve(event); device.input('y'); assert.equal(await approval, true);
 approval = ui.approve(event); ui.cancelPrompt(); assert.equal(await approval, false);
 assert.equal(ui.editor.getText(), 'my follow-up draft');
});

test('searchable model picker filters, selects, and cancels without discarding draft', async t => {
 const { ui, device } = await fixture(t);
 device.input('draft');
 const items = [{ value: 'alpha', label: 'Alpha' }, { value: 'provider/beta', label: 'Beta' }];
 let choice = ui.select('Select model', items, 'alpha');
 device.input('bet'); device.input('\r'); assert.equal(await choice, 'provider/beta');
 assert.equal(ui.editor.getText(), 'draft');
 choice = ui.select('Select model', items); device.input('\x1b'); assert.equal(await choice, null);
});

test('auto-approve requires selecting the session option and preserves the editor draft', async t => {
 const { ui, device } = await fixture(t);
 ui.beginPrompt('run commands'); device.input('follow-up draft');
 const approval = ui.approve({ name: 'run_command' });
 assert.match(rendered(ui), /Auto-approve session/);
 assert.match(rendered(ui), /all tools and workers/);
 device.input('\x1b[B'); device.input('\x1b[B'); device.input('\r');
 assert.equal(await approval, 'full');
 assert.equal(ui.editor.getText(), 'follow-up draft');
 const controller = new AbortController();
 const cancelled = ui.approve({ name: 'run_command', signal: controller.signal });
 device.input('\x1b[B'); device.input('\x1b[B'); device.input('\r'); controller.abort();
 assert.equal(await cancelled, false);
});

test('resume picker searches session metadata and cancellation preserves the current draft', async t => {
 const { ui, device, session } = await fixture(t);
 ui.editor.setText('Draft to keep');
 const items = [{ value: 'alpha', label: 'First task', description: '/projects/alpha' }, { value: 'beta', label: 'Second task', description: '/projects/beta' }];
 let choice = ui.select('Resume session', items, undefined, { placeholder: 'Search sessions…' });
 assert.match(rendered(ui), /Search sessions/);
 device.input('projects/beta'); device.input('\r'); assert.equal(await choice, 'beta');
 choice = ui.select('Resume session', items); device.input('\x1b'); assert.equal(await choice, null);
 assert.equal(ui.editor.getText(), 'Draft to keep');
 ui.beginPrompt('Old conversation'); ui.endTurn();
 const resumed = { ...session, id: 'beta', cwd: path.dirname(session.cwd), messages: [{ role: 'user', content: 'Restored conversation' }] };
 ui.reset(resumed); ui.syncContext(ui.options, resumed); ui.restore(resumed);
 assert.equal(ui.projectCwd, resumed.cwd); assert.equal(ui.editor.getText(), '');
 assert.match(rendered(ui), /Restored conversation/); assert(!rendered(ui).includes('Old conversation'));
 assert.equal(ui.session.id, 'beta');
});

test('resume restores chat; exit restores the shell without clearing it or replaying the transcript', async t => {
 const { ui, session, device } = await fixture(t);
 ui.restore({ ...session, messages: [
  { role: 'user', content: 'Previous task' },
  { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'one', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
  { role: 'tool', tool_call_id: 'one', content: '{"text":"saved file contents"}' },
 ] });
 assert.match(rendered(ui), /Previous task/); assert.match(rendered(ui), /saved file contents/);
 const prompt = ui.ask(); device.output = ''; ui.close(); assert.equal(await prompt, null);
 assert(device.output.includes('\x1b[?1049l'));
 assert(!device.output.includes('\x1b[2J'));
 assert(!device.output.includes('\x1b[3J'));
 assert(!device.output.includes('Previous task'));
 assert(!device.output.includes('saved file contents'));
 const afterExit = device.output.split('\x1b[?1049l').at(-1);
 assert.equal(strip(afterExit).trim(), '', 'Exiting must not print editor borders or the model/token footer');
});

test('tool validation failures remain visible even without a start event', async t => {
 const { ui } = await fixture(t);
 ui.emit({ type: 'tool_end', name: 'edit_file', result: { error: 'Found 0 matches. Read again.' } });
 assert.match(rendered(ui), /Found 0 matches/);
});

test('Ctrl+C aborts during approval and resolves the pending decision as denied', async t => {
 const { ui, device } = await fixture(t);
 ui.beginPrompt('run a command');
 let aborted = false; ui.onInterrupt = () => { aborted = true; ui.cancelPrompt(); };
 const decision = ui.approve({ name: 'run_command' });
 device.input('\x03');
 assert(aborted); assert.equal(await decision, false);
});

test('streaming, offscreen changes and spinner ticks never clear the screen or move the input dock', async t => {
 const { ui, device } = await fixture(t);
 device.rows = 24;
 ui.beginPrompt('Generate a long response');
 ui.emit({ type: 'tool_start', name: 'read_file', args: { path: 'file.txt' } });
 ui.emit({ type: 'content', delta: Array.from({ length: 90 }, (_, i) => `Line ${i}\n\n`).join('') });
 ui.tui.renderNow();
 const before = ui.tui.fullRedrawCount;
 device.output = '';
 // The old main-screen renderer cleared and replayed the entire history here.
 ui.emit({ type: 'tool_end', name: 'read_file', result: { text: 'read complete' } });
 ui.tui.renderNow();
 for (const delta of ['\n**Streaming', ' Markdown**', '\n\n```js\n', 'const x = ', '42;\n', '```\n', '\n| a | b |\n|---|---|\n', '| hello | wide column text |\n']) {
  ui.emit({ type: 'content', delta }); ui.tui.renderNow();
  const screen = ui.tui.getScreenLines().map(strip);
  assert.equal(screen.length, device.rows);
  assert.match(screen.at(-1), /test-model/);
  assert.match(screen.at(-5), /Working/);
 }
 const frames = new Set();
 for (let i = 0; i < 4; i++) {
  await new Promise(resolve => setTimeout(resolve, 90));
  ui.tui.renderNow(); frames.add(strip(ui.tui.getScreenLines().at(-5)));
 }
 assert(frames.size > 1, 'Spinner must animate');
 assert.equal(ui.tui.fullRedrawCount, before);
 assert(!device.output.includes('\x1b[2J'), 'No screen clears while generating');
 assert(!device.output.includes('\x1b[3J'), 'No scrollback clears');
 ui.endTurn(); ui.tui.renderNow();
 const stopped = device.output;
 await new Promise(resolve => setTimeout(resolve, 100));
 assert.equal(device.output, stopped, 'No timer writes after generation stops');
});

test('viewport scrolls independently while editor remains visible, and thinking can be collapsed', async t => {
 const { ui, device } = await fixture(t);
 ui.beginPrompt('Read the project');
 ui.emit({ type: 'reasoning', delta: 'Inspect files before editing.\n'.repeat(60) });
 ui.tui.renderNow(); const height = ui.scrollView.scrollTop;
 assert(height > 0);
 device.input('\x1b[5~'); ui.tui.renderNow();
 assert(ui.scrollView.scrollTop < height);
 assert.match(strip(ui.tui.getScreenLines().at(-5)), /Working/);
 device.input('\x14'); ui.tui.renderNow();
 assert.match(rendered(ui), /Thinking\.\.\./);
 assert(!rendered(ui).includes('Inspect files before editing.'));
 device.input('\x14');
 assert.match(rendered(ui), /Inspect files before editing/);
});

test('sub-agent streams stay separate, same-name tools match their owner, and /agents works while busy', async t => {
 const { ui, device, session } = await fixture(t);
 ui.beginPrompt('Delegate two tasks');
 session.subagents = [{ id: 'a', name: 'Alpha', task: 'Inspect API', status: 'running' }, { id: 'b', name: 'Beta', task: 'Inspect UI', status: 'running' }];
 for (const agent of session.subagents) ui.emit({ type: 'subagent_start', agent, model: 'test' });
 const child = (id, event) => ui.emit({ type: 'subagent_event', agent: session.subagents.find(a => a.id === id), event });
 child('a', { type: 'content', delta: 'Private child stream' });
 child('a', { type: 'tool_start', name: 'read_file', args: { path: 'a.txt' } });
 child('b', { type: 'tool_start', name: 'read_file', args: { path: 'b.txt' } });
 child('a', { type: 'tool_end', name: 'read_file', result: { text: 'Result A' } });
 const aCard = ui.cards.find(c => c.event.agentId === 'a');
 const bCard = ui.cards.find(c => c.event.agentId === 'b');
 assert.equal(aCard.result.text, 'Result A'); assert.equal(bCard.result, null);
 child('a', { type: 'turn_end', tokens: 12 }); assert(ui.busy);
 assert(!rendered(ui).includes('Private child stream'));
 device.input('/agents'); device.input('\r'); assert.equal(ui.queue.length, 0);
 assert.match(rendered(ui), /Alpha · running/);
 ui.emit({ type: 'subagent_end', agent: { ...session.subagents[0], status: 'completed', tokens: 12, result: 'API report' } });
 assert.match(rendered(ui), /API report/);
});

test('aborting one worker dismisses its approval and leaves the other worker dialog usable', async t => {
 const { ui, device } = await fixture(t);
 const controller = new AbortController();
 ui.editor.setText('Preserve my draft');
 const first = ui.approve({ name: 'write_file', agentId: 'a', agentName: 'Alpha', signal: controller.signal });
 assert.match(rendered(ui), /\[Alpha\] Allow write_file/);
 controller.abort(); assert.equal(await first, false);
 assert.equal(ui.pickerDone, null);
 const second = ui.approve({ name: 'write_file', agentId: 'b', agentName: 'Beta' });
 device.input('y'); assert.equal(await second, true);
 assert.equal(ui.editor.getText(), 'Preserve my draft');
});
