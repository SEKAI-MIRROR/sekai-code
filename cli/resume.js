'use strict';
const fs = require('node:fs/promises');
const Config = require('./config');
const Gateway = require('../desktop/sekai');
const { clean } = require('./terminal');

async function selectSession(terminal) {
 const sessions = await Config.sessions();
 if (!sessions.length) { terminal.note('No saved sessions. Start a conversation first.'); return null; }
 const items = sessions.map(session => ({
  value: session.id,
  label: clean(session.title || '(untitled)').replace(/\s+/g, ' '),
  description: clean(`${session.updated.slice(0, 16).replace('T', ' ')} · ${session.messages?.length || 0} messages · ${session.provider}/${session.model || 'no model'} · ${session.cwd} · ${session.id.slice(0, 8)}`),
 }));
 if (terminal.rich) return terminal.select('Resume session', items, undefined, { placeholder: 'Search sessions…' });
 terminal.note(items.map((item, index) => `  ${index + 1}. ${item.label}\n     ${item.description}`).join('\n'));
 const choice = (await terminal.ask('  Session number or ID (Enter to cancel): '))?.trim();
 if (!choice) return null;
 if (/^\d+$/.test(choice)) {
  const item = items[Number(choice) - 1];
  if (!item) throw new Error('Invalid session number.');
  return item.value;
 }
 return choice;
}

async function prepareResume(id, { options, flags = {}, cwd }) {
 const session = await Config.loadSession(id);
 if (!session || typeof session.cwd !== 'string' || !Array.isArray(session.messages) || session.messages.some(message => !message || typeof message.role !== 'string')) throw new Error('Invalid saved session.');
 let directory;
 try {
  directory = await fs.realpath(session.cwd);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('Not a directory');
 } catch { throw new Error(`Saved project directory is not available: ${session.cwd}`); }
 if (flags.cwd && cwd !== directory) throw new Error('Resume must use the original project directory.');
 const next = { ...options };
 // Restore conversation settings, never saved permissions, endpoints, or credentials.
 if (!flags.provider && session.provider !== next.provider) {
  next.provider = session.provider;
  if (!flags['base-url']) delete next.baseUrl;
  if (!flags.effort) delete next.effort;
 }
 if (!flags.model && (!flags.provider || flags.provider === session.provider)) next.model = session.model;
 if (next.provider === 'sekai') next.model ||= Gateway.DEFAULT_MODEL;
 Config.validate(next);
 return { session: { ...session, cwd: directory }, options: next, cwd: directory };
}

module.exports = { selectSession, prepareResume };
