import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProbeEngine } from '../lib/engine.js';
import { CatalogCache, CACHE_EPOCH, CACHE_VERSION } from '../lib/catalog-cache.js';
import { probeModels } from '../lib/probes.js';
import { hookModelDiscovery, apply } from '../lib/index.js';

function fixture(fetcher = async () => Response.json({ data: [{ id: 'model' }] }), cache) {
  const current = { providers: { test: { api: 'openai-completions', baseURL: 'https://configured.test/v1', apiKeyEnv: 'FIXTURE_KEY', headers: { 'X-Api-Key': 'stored-header-fixture' } }, 'openai-codex': {} } };
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: current } };
  let credentialReads = 0, key = 'stored-key-fixture';
  const ctx = {
    configEditor: { entries: () => [entry], configuration: () => [{ entry, inherited: {} }], edit: () => assert.fail('no profile writes') },
    llm: { listModels: async () => [] },
    credentials: { resolve: async () => { credentialReads++; return { value: key }; }, readRecord: async () => { credentialReads++; return undefined; } }
  };
  const manager = new ProbeEngine(ctx, { credentialRef: x => x, credentialKey: (a, b) => `${a}/${b}` }, { transport: { fetch: fetcher, timeoutMs: 1000 }, catalogCache: cache });
  return { manager, ctx, current, reads: () => credentialReads, rotate: value => { key = value; } };
}

test('discovery hook preserves other set wrappers and becomes inert on disposal', async () => {
  const original = async () => [{ id: 'original' }], discoveries = new Map([['llm-pi-ai', original]]);
  let writes = 0;
  const priorSet = function (key, value) { writes++; return Map.prototype.set.call(this, key, value); };
  discoveries.set = priorSet;
  const stop = hookModelDiscovery({ llm: { discoveries } }, { discoverForSettings: async () => [{ id: 'hook' }] });
  const staleCallback = discoveries.get('llm-pi-ai');
  assert.equal((await staleCallback())[0].id, 'hook');
  stop();
  assert.equal(discoveries.set, priorSet); assert.equal(discoveries.get('llm-pi-ai'), original);
  assert.equal((await staleCallback())[0].id, 'original'); assert.ok(writes >= 2);
});

test('failed RPC installation rolls back the discovery hook', async () => {
  const original = async () => [], discoveries = new Map([['llm-pi-ai', original]]);
  const ctx = {
    configEditor: { edit() {} },
    llm: { discoveries }, profileContext: { dir: 'D:/Data/.temp/model-probe-audit-runtime' },
    loader: { import: async name => name.includes('providers/all') ? { builtinProviders: () => [], getBuiltinProviders: () => [], getBuiltinModelDataGeneratedAt: () => 'fixture' } : {} },
    connection: { fetch: { register: () => { throw new Error('fixture registration collision'); } } },
    effect: fn => fn()
  };
  await assert.rejects(apply(ctx), /fixture registration collision/);
  assert.equal(discoveries.get('llm-pi-ai'), original);
  assert.equal(Object.hasOwn(discoveries, 'set'), false);
});

test('draft endpoint or protocol changes cannot read or forward stored credentials', async () => {
  const f = fixture(() => assert.fail('must not fetch'));
  for (const request of [
    { provider: 'test', baseURL: 'https://other.test/v1' },
    { provider: 'test', api: 'anthropic-messages' },
    { provider: 'openai-codex', baseURL: 'https://other.test' },
    { provider: 'openai-codex', api: 'openai-completions' }
  ]) await assert.rejects(f.manager.refreshForSettings(request), { code: 'ENDPOINT_CONFIRM_REQUIRED' });
  assert.equal(f.reads(), 0);
  f.manager.dispose();
});

test('unsupported drafts cannot bypass credential isolation through the original adapter', async () => {
  const f = fixture(() => assert.fail('must not fetch'));
  for (const request of [{ provider: 'test', api: 'unknown' }, { provider: 'unknown', apiKey: '' }]) {
    await assert.rejects(f.manager.refreshForSettings(request, undefined, () => assert.fail('must not fall back')), { code: 'UNSUPPORTED_PROTOCOL' });
  }
  assert.equal(f.reads(), 0); f.manager.dispose();
});

test('explicit draft keys including empty are independent, uncached, and never inherit saved headers', async () => {
  const requests = [], releases = [];
  const cache = { read: () => assert.fail('draft cache read'), write: () => assert.fail('draft cache write') };
  const f = fixture((url, init) => new Promise(resolve => { requests.push({ url, init }); releases.push(resolve); }), cache);
  const a = f.manager.refreshForSettings({ provider: 'test', apiKey: 'draft-one' });
  const b = f.manager.refreshForSettings({ provider: 'test', apiKey: 'draft-two' });
  const empty = f.manager.refreshForSettings({ provider: 'test', apiKey: '', baseURL: 'https://draft.test/v1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(x => x.init.headers.authorization), ['Bearer draft-one', 'Bearer draft-two', undefined]);
  assert.ok(requests.every(x => !('x-api-key' in x.init.headers)));
  releases[1](Response.json({ data: [{ id: 'two' }] }));
  releases[0](Response.json({ data: [{ id: 'one' }] }));
  releases[2](Response.json({ data: [{ id: 'anonymous' }] }));
  assert.equal((await a)[0].id, 'one'); assert.equal((await b)[0].id, 'two'); assert.equal((await empty)[0].id, 'anonymous');
  assert.equal(f.reads(), 0);
  f.manager.dispose();
});

test('retry returns the latest vendor models instead of the old cached catalog', async () => {
  let calls = 0;
  const f = fixture(async () => Response.json({ data: [{ id: ++calls === 1 ? 'old-model' : 'gpt-6.1-sol' }] }));
  try {
    assert.equal((await f.manager.refreshForSettings({ provider: 'test' }))[0].id, 'old-model');
    assert.equal((await f.manager.refreshForSettings({ provider: 'test' }))[0].id, 'gpt-6.1-sol');
    assert.equal(calls, 2);
    f.manager.transport.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(f.manager.refreshForSettings({ provider: 'test' }), { code: 'NETWORK_ERROR' }, 'offline must not masquerade as a successful refresh');
  } finally { f.manager.dispose(); }
});

test('saved credential rotation cannot return a previous account catalog', async () => {
  let calls = 0;
  const f = fixture(async () => Response.json({ data: [{ id: `account-${++calls}` }] }));
  assert.equal((await f.manager.refreshForSettings({ provider: 'test' }))[0].id, 'account-1');
  f.rotate('rotated-key-fixture');
  assert.equal((await f.manager.refreshForSettings({ provider: 'test' }))[0].id, 'account-2');
  assert.equal(calls, 2);
  f.manager.dispose();
});

test('discovery cancellation and disposal abort transport without cancelling other callers', async () => {
  const requests = [];
  const f = fixture((url, init) => new Promise(resolve => requests.push({ init, resolve })));
  const controller = new AbortController();
  const a = f.manager.refreshForSettings({ provider: 'test', apiKey: 'fixture-key-one' }, controller.signal);
  const b = f.manager.refreshForSettings({ provider: 'test', apiKey: 'fixture-key-two' });
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(a, { code: 'CANCELLED' });
  controller.abort(); await rejected;
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(requests[1].init.signal.aborted, false);
  requests[1].resolve(Response.json({ data: [{ id: 'two' }] })); await b;
  const c = f.manager.refreshForSettings({ provider: 'test', apiKey: 'three' });
  const stopped = assert.rejects(c, { code: 'CANCELLED' });
  f.manager.dispose(); await stopped;
  await assert.rejects(f.manager.refreshForSettings({ provider: 'test' }, undefined, () => assert.fail('disposed fallback')), { code: 'UNAVAILABLE' });
});

test('cancel and dispose also settle a stalled credential lookup without fetching', async () => {
  for (const dispose of [false, true]) {
    const f = fixture(() => assert.fail('must not fetch'));
    f.ctx.credentials.resolve = () => new Promise(() => {});
    const controller = new AbortController();
    const result = f.manager.refreshForSettings({ provider: 'test' }, controller.signal);
    const stopped = assert.rejects(result, { code: 'CANCELLED' });
    if (dispose) f.manager.dispose(); else controller.abort();
    await stopped; f.manager.dispose();
  }
});

test('legacy credential-agnostic cache is ignored; scoped catalogs survive reload without raw credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-probe-audit-cache-'));
  await mkdir(join(dir, '.model-probe-cache'));
  const file = join(dir, '.model-probe-cache', 'catalogs.json');
  await writeFile(file, JSON.stringify({ version: 1, catalogs: [{ route: 'test', api: 'openai-completions', baseURL: 'https://configured.test/v1', models: [{ id: 'legacy-other-account' }] }] }));
  const f = fixture(undefined, new CatalogCache(dir));
  assert.equal((await f.manager.refreshForSettings({ provider: 'test' }))[0].id, 'model');
  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes('stored-key-fixture')); assert.ok(!text.includes('stored-header-fixture'));
  const data = JSON.parse(text); assert.equal(data.version, CACHE_VERSION); assert.equal(data.scope.epoch, CACHE_EPOCH); assert.match(data.catalogs[0].authScope, /^[a-f0-9]{64}$/);
  const reopened = new CatalogCache(dir);
  assert.equal((await reopened.read(data.catalogs[0]))[0].id, 'model');
  assert.equal(await reopened.read({ ...data.catalogs[0], authScope: '0'.repeat(64) }), undefined);
  f.manager.dispose();
});

test('a pre-upgrade cache scope is ignored so stale reasoning metadata cannot feed native saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-probe-audit-cache-'));
  await mkdir(join(dir, '.model-probe-cache'));
  const file = join(dir, '.model-probe-cache', 'catalogs.json');
  const entry = { route: 'test', api: 'openai-completions', baseURL: 'https://configured.test/v1', authScope: 'a'.repeat(64), models: [{ id: 'stale', reasoningEfforts: { high: 'high' } }] };
  await writeFile(file, JSON.stringify({ version: 2, catalogs: [entry] }));
  assert.equal(await new CatalogCache(dir).read(entry), undefined, 'v2 files carry no compatibility scope');
  await writeFile(file, JSON.stringify({ version: CACHE_VERSION, scope: { epoch: 'dsh-0.2.0/pi-ai-0.87.1', catalog: 1 }, catalogs: [entry] }));
  assert.equal(await new CatalogCache(dir, { catalogGeneratedAt: 1 }).read(entry), undefined, 'old epoch is ignored');
  await writeFile(file, JSON.stringify({ version: CACHE_VERSION, scope: { epoch: CACHE_EPOCH, catalog: 1 }, catalogs: [entry] }));
  assert.equal(await new CatalogCache(dir, { catalogGeneratedAt: 2 }).read(entry), undefined, 'old catalog generation is ignored');
  assert.equal((await new CatalogCache(dir, { catalogGeneratedAt: 1 }).read(entry))[0].id, 'stale');
});

test('model metadata cannot echo custom credential headers or bearer payloads', async () => {
  for (const [name, value, echoed] of [['X-Api-Key', 'header-key-fixture', 'header-key-fixture'], ['Authorization', 'Bearer header-token-fixture', 'header-token-fixture'], ['Cookie', 'session=cookie-fixture', 'session=cookie-fixture']]) {
    await assert.rejects(probeModels({ api: 'openai-completions', headers: { [name]: value } }, { fetch: async () => Response.json({ data: [{ id: echoed }] }) }), { code: 'SENSITIVE_RESPONSE' });
  }
});
