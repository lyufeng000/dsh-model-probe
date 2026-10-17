import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './picker-fixture.mjs';
test('picker refresh reuses the original request, blocks double clicks and retains prior choices', async () => {
  const f = fixture();
  try {
    await f.open([{ id: 'kept' }, { id: 'unpicked' }]); f.row('unpicked').click();
    const button = f.buttons[0]; button.click(); button.click(); await f.flush();
    assert.equal(f.calls, 1); assert.equal(button.disabled, true);
    await f.finish([{ id: 'kept' }, { id: 'unpicked' }, { id: 'gpt-6.1-sol' }]);
    assert.equal(button.disabled, false); assert.equal(f.row('unpicked').checked, false);
    assert.ok(f.row('gpt-6.1-sol')); assert.match(button.title, /已重新获取/);
  } finally { f.dispose(); }
});
test('an immediately completed refresh restores choices even without an observable busy frame', async () => {
  const f = fixture();
  try {
    await f.open([{ id: 'kept' }]); f.row('kept').click(); f.query('kept');
    f.owner.click = () => { f.setRows([{ id: 'kept' }, { id: 'new' }]); f.search.value = ''; return Promise.resolve({ ok: true }); };
    f.buttons[0].click(); await f.flush(); await f.flush();
    assert.equal(f.buttons[0].disabled, false); assert.equal(f.row('kept').checked, false); assert.equal(f.search.value, 'kept');
  } finally { f.dispose(); }
});
test('refresh failure is exposed on the button, without any extra panel or fake success', async () => {
  const f = fixture();
  try {
    await f.open([{ id: 'old' }]); f.buttons[0].click(); await f.flush();
    await f.finish([{ id: 'old' }], '厂商未返回有效 JSON。');
    assert.match(f.buttons[0].title, /JSON/); assert.doesNotMatch(f.buttons[0].title, /已重新获取/);
    assert.equal(f.buttons[0].disabled, false); assert.equal(f.added, 1);
  } finally { f.dispose(); }
});
test('search text and choices not currently visible in the filter survive refresh', async () => {
  const f = fixture();
  try {
    await f.open([{ id: 'hidden' }, { id: 'visible' }]); f.row('hidden').click();
    f.query('visible'); f.setRows([{ id: 'visible' }]); await f.flush();
    f.buttons[0].click(); await f.flush();
    f.row('visible').click(); f.query('new');
    await f.finish([{ id: 'hidden' }, { id: 'visible' }, { id: 'new' }]);
    assert.equal(f.search.value, 'new'); assert.equal(f.row('hidden').checked, false);
    assert.equal(f.row('visible').checked, false);
  } finally { f.dispose(); }
});
