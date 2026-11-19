'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('public dashboard inline JavaScript parses successfully', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/gi)];
  assert.equal(scripts.length, 1, 'expected one inline application script');
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
});
