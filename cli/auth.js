'use strict';
const readline = require('node:readline');
const { Writable } = require('node:stream');
function promptKey() {
 if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Use sekai login --key-stdin to read a key from noninteractive input.');
 const hidden = new Writable({ write(chunk, encoding, done) { done(); } });
 const rl = readline.createInterface({ input: process.stdin, output: hidden, terminal: true, historySize: 0 });
 process.stderr.write('API key (hidden): ');
 return new Promise((resolve, reject) => {
  let finished = false;
  const done = (error, value) => { if (finished) return; finished = true; rl.close(); process.stderr.write('\n'); error ? reject(error) : resolve(value); };
  rl.on('SIGINT', () => done(new Error('Login cancelled.')));
  rl.on('close', () => done(new Error('Login cancelled.')));
  rl.question('', key => done(null, key.trim()));
 });
}
module.exports = { promptKey };
