'use strict';
const fs = require('node:fs/promises');
const syncFS = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const Gateway = require('../desktop/sekai');
const home = () => path.resolve(process.env.SEKAI_HOME || path.join(os.homedir(), '.sekai'));
const providers = ['sekai', 'openai', 'anthropic', 'deepseek'];
const modes = ['ask', 'auto', 'full'];
const defaults = { provider: 'sekai', approval: 'ask', maxTurns: 40, maxAgents: 3 };
async function readJSON(file, fallback) {
 try { return JSON.parse(await fs.readFile(file, 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${error.message}`); }
}
async function writeJSON(file, value) {
 await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
 const temp = `${file}.${randomUUID()}.tmp`;
 try {
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
 } finally { await fs.rm(temp, { force: true }); }
}
async function config() {
 const value = { ...defaults, ...await readJSON(path.join(home(), 'config.json'), {}) };
 if (value.provider === 'sekai') value.model ||= Gateway.DEFAULT_MODEL;
 return value;
}
function validate(options) {
 if (!providers.includes(options.provider)) throw new Error(`Provider must be ${providers.join(', ')}.`);
 if (!modes.includes(options.approval)) throw new Error(`Approval must be ${modes.join(', ')}.`);
 if (!Number.isInteger(Number(options.maxTurns)) || Number(options.maxTurns) < 1 || Number(options.maxTurns) > 200) throw new Error('max-turns must be between 1 and 200.');
 if (!Number.isInteger(Number(options.maxAgents ?? 3)) || Number(options.maxAgents ?? 3) < 0 || Number(options.maxAgents ?? 3) > 8) throw new Error('max-agents must be between 0 and 8.');
 if (options.baseUrl) {
  const url = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('base-url must be an HTTP(S) URL without embedded credentials.');
 }
}
async function setConfig(key, value) {
 const allowed = ['provider', 'model', 'approval', 'maxTurns', 'maxAgents', 'baseUrl', 'effort'];
 if (!allowed.includes(key)) throw new Error(`Config keys: ${allowed.join(', ')}. Use sekai login or an environment variable for API keys.`);
 const next = { ...await config(), [key]: ['maxTurns', 'maxAgents'].includes(key) ? Number(value) : value };
 if (key === 'provider' && value !== (await config()).provider) { delete next.model; delete next.baseUrl; delete next.effort; }
 validate(next);
 await writeJSON(path.join(home(), 'config.json'), next);
}
const keyNames = { sekai: 'SEKAI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
const roots = { sekai: Gateway.BASE_URL, openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', deepseek: 'https://api.deepseek.com' };
const origin = options => new URL(options.baseUrl || roots[options.provider]).origin;
function savedCredentials() {
 try {
  const value = JSON.parse(syncFS.readFileSync(path.join(home(), 'credentials.json'), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential store');
  return value;
 }
 catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot read saved credentials. Run sekai login again.'); }
}
function credentialStatus(options) {
 const env = keyNames[options.provider];
 if (process.env[env]?.trim()) return { connected: true, source: env };
 const saved = savedCredentials()[options.provider];
 return { connected: !!saved?.key && saved.origin === origin(options), source: saved?.key ? 'local credentials' : 'none' };
}
function credentials(options) {
 const name = keyNames[options.provider];
 if (process.env[name]?.trim()) return process.env[name].trim();
 const saved = savedCredentials()[options.provider];
 if (saved?.key && saved.origin !== origin(options)) throw new Error('Saved key belongs to a different endpoint. Run sekai login for this endpoint or set an explicit environment key.');
 if (saved?.key) return saved.key;
 throw new Error(`Run sekai login or set ${name} before using ${options.provider}.`);
}
async function saveCredential(options, key) {
 if (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key.trim())) throw new Error('API key must be nonempty and contain no whitespace.');
 await writeJSON(path.join(home(), 'credentials.json'), { ...savedCredentials(), [options.provider]: { key: key.trim(), origin: origin(options) } });
}
async function removeCredential(provider) {
 const value = savedCredentials(); delete value[provider];
 await writeJSON(path.join(home(), 'credentials.json'), value);
}
function sessionFile(id) {
 if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid session ID.');
 return path.join(home(), 'sessions', `${id}.json`);
}
async function sessions({ includeChildren = false } = {}) {
 const dir = path.join(home(), 'sessions');
 const names = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
 const out = [];
 for (const name of names.filter(n => n.endsWith('.json'))) {
  try { const s = await readJSON(path.join(dir, name)); if (s?.id && s.updated && (includeChildren || !s.parentId)) out.push(s); } catch {}
 }
 return out.sort((a, b) => b.updated.localeCompare(a.updated));
}
async function loadSession(id) {
 if (id === 'latest') { const found = (await sessions())[0]; if (!found) throw new Error('No saved sessions.'); return found; }
 const found = await readJSON(sessionFile(id), null);
 if (!found) throw new Error(`Session not found: ${id}`);
 return found;
}
async function saveSession(session) { session.updated = new Date().toISOString(); await writeJSON(sessionFile(session.id), session); }
module.exports = { config, setConfig, validate, credentials, credentialStatus, saveCredential, removeCredential, roots, home, modes, providers, sessions, loadSession, saveSession };
