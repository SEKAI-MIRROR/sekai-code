'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = ['.', 'cli', 'cli/pi', 'desktop', 'scripts', 'test'].flatMap(dir => fs.readdirSync(dir).filter(name => /\.(m?js)$/.test(name)).map(name => path.join(dir, name)));
for (const file of files) {
 const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
 if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
