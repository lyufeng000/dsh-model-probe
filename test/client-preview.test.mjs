import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
function setup() {
  const hooks = []; let index = 0, effects = [], dirty = false;
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState(initial) { const n = index++; if (!hooks[n]) hooks[n] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[n].value, value => { hooks[n].value = typeof value === 'function' ? value(hooks[n].value) : value; dirty = true; }]; },
    useRef(initial) { const n = index++; return hooks[n] ??= { current: initial }; },
    useMemo(fn, deps) { const n = index++; if (!equal(hooks[n]?.deps, deps)) hooks[n] = { deps, value: fn() }; return hooks[n].value; },
    useEffect(fn, deps) { const n = index++; if (!equal(hooks[n]?.deps, deps)) { hooks[n]?.cleanup?.(); hooks[n] = { deps }; effects.push(() => { hooks[n].cleanup = fn(); }); } },
  };
  const window = { confirm: () => true, __ModuleLoader__: { load: entry => entry.factory(() => React) } };
  // Test-only lexical exposure; production exports/packaging remain unchanged.
  const anchor = '    function RouteCard(';
  assert.equal(source.split(anchor).length, 2);
  vm.runInNewContext(source.replace(anchor, '    window.__test = { WritePanel, ManualEditor };\n' + anchor), { window });
  return { ...window.__test, render(component, props) { let tree; do { dirty = false; index = 0; effects = []; tree = component(props); for (const fn of effects) fn(); } while (dirty); return tree; } };
}
const flatten = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flat(Infinity).flatMap(flatten)] : [];
const button = (tree, label) => flatten(tree).find(x => x.tag === 'button' && x.children.join('') === label);
const response = { token: 'fixture', revision: 'r1', action: 'adopt', added: ['new'], removed: [], changed: true, before: {}, after: { models: [{ id: 'new' }] }, sources: [] };
function props(api) { return { row: { route: 'google' }, revision: 'r1', result: { revision: 'r1', models: [{ id: 'new' }] }, selected: new Set(['new']), api, onApplied: async () => {} }; }

test('client discards a late preview after manual result or selection changes', async () => {
  for (const field of ['result', 'selected', 'revision']) {
    const f = setup(); let release; const p = props(() => new Promise(resolve => { release = resolve; }));
    const tree = f.render(f.WritePanel, p), pending = button(tree, '预览写入（1）').props.onClick();
    p[field] = field === 'result' ? { revision: 'r1', models: [{ id: 'changed' }] } : field === 'selected' ? new Set() : 'r2';
    f.render(f.WritePanel, p); release(response); await pending;
    assert.ok(!flatten(f.render(f.WritePanel, p)).some(x => x.tag === 'section'));
  }
});
test('client accepts current preview, cancels without adoption and invalidates it on changes', async () => {
  const f = setup(), calls = [], p = props(async method => { calls.push(method); return response; });
  await button(f.render(f.WritePanel, p), '预览写入（1）').props.onClick();
  let tree = f.render(f.WritePanel, p); assert.ok(button(tree, '确认写入 profile'));
  button(tree, '取消写入').props.onClick(); tree = f.render(f.WritePanel, p); assert.ok(!button(tree, '确认写入 profile')); assert.deepEqual(calls, ['preview']);
  await button(tree, '预览写入（1）').props.onClick(); p.selected = new Set();
  assert.ok(!button(f.render(f.WritePanel, p), '确认写入 profile'));
});
test('manual form preserves image-only and reverse modality order rather than showing an unmatched select', () => {
  for (const input of [['image'], ['image', 'text']]) {
    const f = setup(), row = { route: 'test', declared: [{ id: 'kept', contextWindow: 1000, maxTokens: 200, input }] };
    const tree = f.render(f.ManualEditor, { row, revision: 'r', selected: new Set(), api: async () => {}, onApplied: async () => {} });
    const select = flatten(tree).find(x => x.tag === 'select'); assert.equal(select.props.value, input.join(','));
    assert.ok(flatten(select).some(x => x.tag === 'option' && x.props.value === input.join(',')));
    const panel = flatten(tree).find(x => x.tag === f.WritePanel); assert.equal(JSON.stringify(panel.props.result.models), JSON.stringify(row.declared));
  }
});
