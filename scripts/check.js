'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function sourceFiles(dir) {
 return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? sourceFiles(file) : /\.(m?js)$/.test(entry.name) ? [file] : [];
 });
}
const files = ['cli', 'scripts', 'test'].flatMap(sourceFiles);
for (const file of files) {
 const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
 if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
