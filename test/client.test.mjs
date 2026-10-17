import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fixture, loadModule, source } from './picker-fixture.mjs';
test('client registers the installed identity and no extra settings page or card', () => {
  const f = fixture();
  try { assert.equal(f.added, 1); assert.deepEqual(Array.from(f.module.inject), ['remote', 'remote.llm', 'connection']); assert.doesNotMatch(source, /settings\.section|WritePanel|ManualEditor|RouteCard|createElement\('(?:article|section|p)'\)|\bfetch\(/); }
  finally { f.dispose(); }
});
test('unrelated dialogs remain untouched; empty editor already has its refresh action', () => {
  const f = fixture({ open: true, unrelated: true });
  try { assert.equal(f.added, 1); assert.equal(f.buttons[0].parentElement, f.head); } finally { f.dispose(); }
});
test('the same single button moves into the native picker and back to its source', async () => {
  const f = fixture();
  try {
    const button = f.buttons[0]; assert.equal(button.parentElement, f.head);
    await f.open([{ id: 'old' }]); await f.flush();
    assert.equal(f.added, 1); assert.equal(button.textContent, '刷新 / 重试');
    assert.equal(button.className, 'native-button'); assert.equal(f.calls, 0); assert.equal(button.parentElement, f.toolbar);
    await f.close(); assert.equal(button.parentElement, f.head); assert.equal(f.added, 1);
  } finally { f.dispose(); }
});
test('empty editor refresh can open a picker without an earlier native fetch', async () => {
  const f = fixture();
  try {
    f.buttons[0].click(); await f.flush(); assert.equal(f.calls, 1);
    f.dialog.isConnected = true; await f.finish([{ id: 'new' }]);
    assert.equal(f.buttons[0].parentElement, f.toolbar); assert.equal(f.buttons[0].disabled, false);
  } finally { f.dispose(); }
});
test('dispose releases observations, listeners and only its own button', async () => {
  const f = fixture(); await f.open([{ id: 'old' }]);
  f.dispose(); await f.flush();
  assert.equal(f.observerOff, true); assert.equal(f.listenerCount, 0);
  assert.equal(f.buttons[0].isConnected, false); assert.equal(f.owner.isConnected, true);
});
const runtime = process.env.DSH_MODEL_TEST_RUNTIME;
test('real Cordis namespace getter keeps caller context, scoped click routing and lifecycle', { skip: !runtime && 'Set DSH_MODEL_TEST_RUNTIME to exercise installed Cordis' }, async () => {
  const { Context, Service } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
  // DSH 0.2.1 renamed the browser client bundle to client.browser.js; accept either layout.
  const gatewayDir = path.join(runtime, 'node_modules/@deepseek-ai/dsh-api-gateway/lib');
  const gatewayFile = existsSync(path.join(gatewayDir, 'client.js')) ? path.join(gatewayDir, 'client.js') : path.join(gatewayDir, 'client.browser.js');
  const gateway = await readFile(gatewayFile, 'utf8');
  const start = gateway.indexOf('var RemoteNamespaceService = class');
  const end = gateway.indexOf('\n\t\t};', start) + '\n\t\t};'.length;
  assert.ok(start > 0 && end > start);
  const Namespace = vm.runInNewContext(gateway.slice(start, end) + '\nRemoteNamespaceService;', { _deepseek_ai_cordis: { Service }, remoteServiceKey: name => 'remote.' + name, REMOTE_NAMESPACE_FIELDS: new Set() });
  const ctx = new Context(), caller = ctx.extend({ caller: 'native-picker' });
  const local = [], live = [], token = {};
  const ns = new Namespace(ctx, 'llm', (direct, scoped, callerCtx, args) => { local.push({ direct, scoped, callerCtx, args }); return Promise.resolve({ ok: true, value: [] }); });
  ns.installDirect({ method: 'discoverModels' }, token);
  const remote = { get llm() { return caller.get('remote.llm'); } };
  const original = Object.getOwnPropertyDescriptor(ns, 'discoverModels');
  const connection = { rpc: { call(...args) { live.push(args); return Promise.resolve({ ok: true, value: [{ id: 'live' }] }); } } };
  const { module } = loadModule();
  const hook = module.hookRefresh(remote, connection);
  await remote.llm.discoverModels('llm-pi-ai', { provider: 'mount-effect' });
  assert.equal(local.length, 1); assert.equal(local[0].callerCtx.caller, 'native-picker'); assert.equal(live.length, 0);
  const request = { provider: 'openai', baseURL: 'https://fixture.invalid', apiKey: 'fixture-only' };
  await hook.run({ click() { remote.llm.discoverModels('llm-pi-ai', request); remote.llm.discoverModels('other', request); queueMicrotask(() => remote.llm.discoverModels('llm-pi-ai', {})); } });
  assert.equal(live.length, 1); assert.equal(live[0][0], '/api'); assert.equal(live[0][1], 'model-probe/refreshDiscovery'); assert.equal(live[0][2], request);
  assert.equal(local.length, 3); assert.equal(local.at(-1).callerCtx.caller, 'native-picker');
  assert.throws(() => hook.run({ click() { throw Error('click failed'); } }), /click failed/);
  await remote.llm.discoverModels('llm-pi-ai', {}); assert.equal(live.length, 1);
  const retained = remote.llm.discoverModels;
  hook.dispose(); assert.equal(live[0][3].aborted, true);
  assert.equal(Object.getOwnPropertyDescriptor(ns, 'discoverModels').get, original.get);
  await retained('llm-pi-ai', {}); assert.equal(live.length, 1);
  // Reinstall/HMR: old cleanup must not overwrite a newer gateway definition.
  const second = module.hookRefresh(remote, connection);
  ns.remove('direct', 'discoverModels', token);
  ns.installDirect({ method: 'discoverModels' }, {});
  const replacement = Object.getOwnPropertyDescriptor(ns, 'discoverModels');
  second.dispose(); assert.equal(Object.getOwnPropertyDescriptor(ns, 'discoverModels').get, replacement.get);
  const third = module.hookRefresh(remote, connection); third.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(ns, 'discoverModels').get, replacement.get);
  // Real dependent Fibers: do not mount before remote.llm, and unwind/rebind
  // when a namespace provider is unloaded/replaced (not just a fake descriptor).
  const app = new Context(), dom = fixture(); dom.dispose();
  class Remote extends Service { constructor(c) { super(c, 'remote'); } get llm() { return this.ctx.get('remote.llm'); } }
  const services = app.plugin({ apply(c) { new Remote(c); c.provide('connection', connection); } }); await services.await();
  const client = loadModule({ document: dom.doc }).module;
  const fiber = app.plugin(client); await fiber.await();
  assert.notEqual(fiber.state, 2); assert.equal(dom.buttons.at(-1).isConnected, false);
  let current, before;
  const provideNamespace = async () => {
    const provider = app.plugin({ apply(c) {
      current = new Namespace(c, 'llm', () => Promise.resolve({ ok: true, value: [] }));
      current.installDirect({ method: 'discoverModels' }, {});
      before = Object.getOwnPropertyDescriptor(current, 'discoverModels');
    } });
    await provider.await(); await fiber.await(); return provider;
  };
  const provider = await provideNamespace();
  assert.equal(fiber.state, 2); assert.notEqual(Object.getOwnPropertyDescriptor(current, 'discoverModels').get, before.get);
  dom.owner.click = () => app.remote.llm.discoverModels('llm-pi-ai', request);
  dom.buttons.at(-1).click(); assert.equal(live.length, 2);
  await provider.dispose(); await fiber.await();
  assert.notEqual(fiber.state, 2); assert.equal(live.at(-1)[3].aborted, true);
  assert.equal(Object.getOwnPropertyDescriptor(current, 'discoverModels').get, before.get);
  assert.equal(dom.buttons.at(-1).isConnected, false);
  const replacementProvider = await provideNamespace(); assert.equal(fiber.state, 2);
  dom.buttons.at(-1).click(); assert.equal(live.length, 3);
  await fiber.dispose(); assert.equal(Object.getOwnPropertyDescriptor(current, 'discoverModels').get, before.get);
  await replacementProvider.dispose(); await services.dispose();
});
