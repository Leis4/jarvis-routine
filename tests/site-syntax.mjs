// Static guard for the shipped frontend bundle.
// A stray escape such as `\'` outside a string literal is a syntax error that
// silently kills a whole script in the browser: the app then keeps running the
// older in-page behaviour with no visible error, which is how the local planner
// disappeared from production. Compile every shipped script here.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const SITE = new URL('../site/', import.meta.url);
const SCRIPTS = ['smart.js', 'ai.js', 'service-worker.js'];

for (const name of SCRIPTS) {
  test(`site/${name} parses as JavaScript`, () => {
    const src = readFileSync(new URL(name, SITE), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: name }));
  });
}

test('site/index.html inline script parses as JavaScript', () => {
  const html = readFileSync(new URL('index.html', SITE), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(blocks.length > 0, 'no inline script found in index.html');
  for (let i = 0; i < blocks.length; i++) {
    assert.doesNotThrow(() => new vm.Script(blocks[i][1], { filename: `index.html#inline-${i + 1}` }));
  }
});

test('local planner API is exported for the AI layer', () => {
  const src = readFileSync(new URL('smart.js', SITE), 'utf8');
  for (const api of ['window.buildSmartPlan=buildSmartPlan', 'window.smartReplan=smartReplan', 'window.revertPlan=revertPlan']) {
    assert.ok(src.includes(api), `missing global export: ${api}`);
  }
});
