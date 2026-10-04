'use strict';

// Provider API keys, kept in the main process and encrypted when OS storage is available.
// They are read once before the window opens, so the page gets them at once and the keychain is never asked mid-animation.
// The file is under a kilobyte, so it is read and written at once: the main process can pick up the thread pool's answers,
// and even its own timers, late when a page's request set them off.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BASE_URL } = require('./sekai');
const { app, ipcMain, safeStorage } = require('electron');

const PROVIDERS = new Set(['sekai', 'openai', 'anthropic', 'deepseek']);
// Windows can refuse for a moment to replace a file something still has open, as an antivirus scan does right after a write.
const RETRY = { times: 6, wait: 15, codes: new Set(['EPERM', 'EACCES', 'EBUSY']) };

let keys = {};

const file = () => path.join(app.getPath('userData'), 'store', 'auth', 'keys.bin');
const encrypted = () => safeStorage.isEncryptionAvailable();
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function load() {
 let saved = {};
 try {
  const data = fs.readFileSync(file());
  saved = JSON.parse(encrypted() ? safeStorage.decryptString(data) : data.toString('utf8'));
  keys = Object.fromEntries(Object.entries(saved).filter(([provider, key]) => PROVIDERS.has(provider) && typeof key === 'string' && key));
 } catch {
  saved = {};
  keys = {};
 }
 // A CLI login also connects a fresh desktop installation. A desktop deletion
 // stores an empty entry, so the next launch does not silently reconnect it.
 if (process.env.SEKAI_API_KEY?.trim()) keys.sekai = process.env.SEKAI_API_KEY.trim();
 else if (!Object.hasOwn(saved, 'sekai')) {
  try {
   const local = path.join(process.env.SEKAI_HOME || path.join(os.homedir(), '.sekai'), 'credentials.json');
   const account = JSON.parse(fs.readFileSync(local, 'utf8')).sekai;
   if (typeof account?.key === 'string' && account.origin === new URL(BASE_URL).origin) keys.sekai = account.key;
  } catch {}
 }
}

// Swapped whole, so the file is never left half-written.
function save(value) {
 const text = JSON.stringify(value), target = file(), temp = `${target}.tmp`;
 fs.mkdirSync(path.dirname(target), { recursive: true });
 fs.writeFileSync(temp, encrypted() ? safeStorage.encryptString(text) : text, { mode: 0o600 });
 for (let attempt = 1; ; attempt++) {
  try {
   fs.renameSync(temp, target);
   return;
  } catch (error) {
   if (attempt > RETRY.times || !RETRY.codes.has(error.code)) throw error;
   pause(RETRY.wait * attempt);
  }
 }
}

// The keys in memory change only once the file has them, so a failed write leaves both as they were.
function write(provider, key) {
 const value = { ...keys };
 if (key || provider === 'sekai') value[provider] = key;
 else delete value[provider];
 save(value);
 keys = value;
}

function register(fromApp) {
 ipcMain.on('keys:read', event => { event.returnValue = fromApp(event) ? { ...keys } : {}; });
 ipcMain.handle('keys:write', (event, provider, key) => {
  if (!fromApp(event) || !PROVIDERS.has(provider) || typeof key !== 'string') return false;
  write(provider, key.trim());
  return true;
 });
}

module.exports = { load, register };
