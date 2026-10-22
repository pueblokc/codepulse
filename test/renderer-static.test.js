'use strict';
// The renderer runs under CSP "script-src 'self'", which silently blocks
// inline event-handler attributes. These checks keep buttons from going dead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

test('index.html has no inline event handlers or inline scripts', () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(html, /script-src 'self'/);
});

test('app.js does not generate inline event handlers', () => {
  assert.doesNotMatch(app, /\son(click|change|input|keydown)\s*=\s*["'`]/i);
});

test('every data-action in index.html is handled in app.js', () => {
  const actions = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]));
  assert.ok(actions.size >= 8);
  for (const a of actions) assert.match(app, new RegExp(`case '${a}'`), a);
});

test('every tab button has a matching tab panel', () => {
  for (const [, id] of html.matchAll(/class="tab[^"]*" data-tab="([^"]+)"/g)) {
    assert.match(html, new RegExp(`id="tab-${id}"`), id);
  }
});
