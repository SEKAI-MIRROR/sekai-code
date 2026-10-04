'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('../cli/terminal');

test('plain approval accepts explicit full mode and otherwise preserves deny and allow once', async () => {
 const terminal = new Terminal();
 terminal.interactive = true;
 for (const [response, expected] of [['', false], [null, false], ['n', false], ['y', true], ['YES', true], [' full ', 'full'], ['FULL', 'full'], ['f', false]]) {
  terminal.ask = async label => { assert.match(label, /auto-approve all tools and workers/); return response; };
  assert.equal(await terminal.approve({ name: 'run_command' }), expected);
 }
 const controller = new AbortController();
 terminal.ask = async () => { controller.abort(); return 'full'; };
 assert.equal(await terminal.approve({ name: 'run_command', signal: controller.signal }), false);
 terminal.interactive = false;
 terminal.ask = async () => assert.fail('Noninteractive mode must not prompt');
 assert.equal(await terminal.approve({ name: 'run_command' }), false);
});
