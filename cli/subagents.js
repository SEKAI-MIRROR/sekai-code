'use strict';
const { randomUUID } = require('node:crypto');

const tool = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const schemas = [
 tool('spawn_agent', 'Start a sub-agent asynchronously with an independent conversation in the same project. Supply a self-contained task and file ownership. It inherits your provider, model and approval policy. Returns an ID immediately; collect its report with wait_agents.', { name: { type: 'string', description: 'Short task label, at most 60 characters' }, task: { type: 'string', description: 'Complete task, context, constraints, and files this agent owns; at most 16000 characters' } }, ['name', 'task']),
 tool('wait_agents', 'Wait for all selected sub-agents and return their reports. Omit ids to collect all. Review reports before giving the user a final answer.', { ids: { type: 'array', items: { type: 'string' }, description: 'Agent IDs returned by spawn_agent' } }),
 tool('list_agents', 'List sub-agent IDs, tasks, statuses and usage for this session.'),
 tool('cancel_agent', 'Cancel one sub-agent, wait for its tools to stop, and return its status. Completed file edits are not undone.', { id: { type: 'string' } }, ['id']),
];
const names = new Set(schemas.map(s => s.function.name));
function serial() {
 let tail = Promise.resolve();
 return fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
}
function addUsage(session, usage) {
 session.tokens = (session.tokens || 0) + (usage.total_tokens || 0);
 session.usage ||= { input: 0, output: 0 };
 session.usage.input += usage.prompt_tokens || usage.input_tokens || 0;
 session.usage.output += usage.completion_tokens || usage.output_tokens || 0;
}
const report = record => ({ id: record.id, name: record.name, status: record.status, task: record.task, tokens: record.tokens || 0, ...(record.result !== undefined ? { result: record.result } : {}), ...(record.error ? { error: record.error } : {}) });

class Subagents {
 constructor({ session, options, signal, emit, save, runWorker }) {
  Object.assign(this, { session, options, signal, emit, save, runWorker });
  this.limit = Number(options.maxAgents ?? 3);
  this.jobs = new Map(); this.unreported = new Set(); this.persistenceError = null;
  session.subagents ||= [];
  // No worker process survives a CLI restart. Never report a saved running job as live.
  for (const record of session.subagents) if (record.status === 'running') {
   record.status = 'interrupted'; record.error = 'Previous process ended before this agent completed.';
  }
 }
 list() { return this.session.subagents.map(report); }
 async execute(name, args) {
  this.signal.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Agent arguments must be an object.');
  const allowed = { spawn_agent: ['name', 'task'], wait_agents: ['ids'], list_agents: [], cancel_agent: ['id'] }[name];
  if (!allowed || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported sub-agent option. Workers inherit the parent settings.');
  if (name === 'spawn_agent') return this.spawn(args);
  if (name === 'wait_agents') return { agents: await this.wait(args.ids) };
  if (name === 'list_agents') return { agents: this.list() };
  const record = this.session.subagents.find(a => a.id === args.id);
  if (!record) throw new Error('Unknown agent ID.');
  const job = this.jobs.get(record.id);
  job?.controller.abort(new Error('Cancelled by the parent agent.'));
  await job?.done;
  this.unreported.delete(record.id);
  return report(record);
 }
 async spawn({ name, task }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Agent name must be 1–60 characters without control characters.');
  if (typeof task !== 'string' || !task.trim() || task.length > 16000) throw new Error('Agent task must be 1–16000 characters.');
  if (this.limit === 0) throw new Error('Sub-agents are disabled (--max-agents 0).');
  if ([...this.jobs.values()].filter(job => job.record.status === 'running').length >= this.limit) throw new Error(`At most ${this.limit} sub-agents may run at once. Wait for an existing agent before spawning another.`);
  if (this.jobs.size >= this.limit * 4) throw new Error(`Reached the ${this.limit * 4} sub-agent limit for this user turn. Reuse completed reports.`);
  const child = { id: randomUUID(), parentId: this.session.id, cwd: this.session.cwd, provider: this.options.provider, model: this.options.model, messages: [], tokens: 0 };
  const record = { id: child.id, name: name.trim(), task: task.trim(), status: 'running', tokens: 0, started: new Date().toISOString() };
  const controller = new AbortController();
  const signal = AbortSignal.any([this.signal, controller.signal]);
  const job = { controller, record, done: null };
  this.jobs.set(child.id, job); this.session.subagents.push(record); this.unreported.add(child.id);
  try { await this.save(this.session); }
  catch (error) { record.status = 'failed'; record.error = error.message; this.jobs.delete(child.id); this.unreported.delete(child.id); throw error; }
  this.emit({ type: 'subagent_start', agent: report(record), model: child.model });
  job.done = (async () => {
   try {
    signal.throwIfAborted();
    const result = await this.runWorker({ child, record, signal, emit: event => {
     if (event.type === 'usage') { addUsage(this.session, event.usage); record.tokens = child.tokens; }
     this.emit({ type: 'subagent_event', agent: { id: record.id, name: record.name }, event });
    } });
    record.status = signal.aborted ? 'cancelled' : 'completed'; record.result = String(result || '').slice(0, 16000);
    if (String(result || '').length > 16000) record.result += '\n[Report truncated; full result is in the child session.]';
   } catch (error) {
    record.status = signal.aborted ? 'cancelled' : 'failed'; record.error = error.message;
   } finally {
    record.tokens = child.tokens || 0; record.ended = new Date().toISOString();
    child.workerStatus = record.status;
    if (record.error) child.workerError = record.error;
    try { await this.save(child); await this.save(this.session); }
    catch (error) { this.persistenceError = error; record.status = 'failed'; record.error = `Could not save sub-agent state: ${error.message}`; }
    this.emit({ type: 'subagent_end', agent: report(record) });
   }
  })();
  return { id: record.id, name: record.name, status: 'running' };
 }
 async wait(ids) {
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('ids must be an array of agent IDs.');
  const selected = ids === undefined ? [...this.jobs.keys()] : [...new Set(ids)];
  const records = selected.map(id => {
   const record = this.session.subagents.find(a => a.id === id);
   if (!record) throw new Error(`Unknown agent ID: ${id}`);
   return record;
  });
  await Promise.all(records.map(record => this.jobs.get(record.id)?.done));
  if (this.persistenceError) throw this.persistenceError;
  this.signal.throwIfAborted();
  for (const record of records) this.unreported.delete(record.id);
  return records.map(report);
 }
 async close() {
  for (const job of this.jobs.values()) if (job.record.status === 'running') job.controller.abort(new Error('Parent turn ended.'));
  await Promise.all([...this.jobs.values()].map(job => job.done));
  if (this.persistenceError) throw this.persistenceError;
 }
}
module.exports = { Subagents, schemas, names, serial, addUsage };
