import test from 'node:test';
import assert from 'node:assert/strict';
import { completeNativeModels, hookNativeModelSave, exactModelEdit } from '../lib/native-save.js';
import { parseListing } from '../lib/probes.js';
import { modelFields, validateDraft } from '../lib/model.js';
import { enrichModels } from '../lib/enrich.js';
import { CatalogCache } from '../lib/catalog-cache.js';
import { ProbeEngine } from '../lib/engine.js';

const efforts = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const vendor = { models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [...Object.keys(efforts), 'ultra'].map(effort => ({ effort })), context_window: 760000 }] };
const base = { providers: { 'openai-codex': { models: [{ id: 'old', compat: { supportsStore: false } }] }, other: { models: [{ id: 'untouched' }] } } };
const rows = [{ route: 'openai-codex', config: base.providers['openai-codex'], models: [{ id: 'gpt-6.1-sol', reasoningEfforts: efforts }] }];
function draft() { const next = structuredClone(base); next.providers['openai-codex'].models.push({ id: 'gpt-6.1-sol', name: 'Sol' }); return next; }

test('Codex reasoning survives parsing, enrichment, draft validation and cache projection', async () => {
  const parsed = parseListing(vendor, 'openai-codex-responses');
  assert.deepEqual(parsed[0].reasoningEfforts, efforts);
  assert.equal(parsed[0].reasoningEfforts.ultra, undefined);
  const enriched = enrichModels(parsed);
  assert.equal(enriched[0].sources.reasoningEfforts, 'vendor');
  assert.deepEqual(validateDraft(enriched)[0].reasoningEfforts, efforts);
  const cache = new CatalogCache(), plan = { route: 'openai-codex' };
  await cache.write(plan, enriched);
  const saved = await cache.read(plan);
  assert.deepEqual(saved[0].reasoningEfforts, efforts);
  saved[0].reasoningEfforts.high = 'modified';
  assert.equal((await cache.read(plan))[0].reasoningEfforts.high, 'high');
  assert.equal(parseListing({ models: [{ slug: 'unknown' }] }, 'openai-codex-responses')[0].reasoningEfforts, undefined);
});

test('reasoning fields accept explicit disable and reject invalid declarations', () => {
  assert.equal(modelFields({ id: 'off', reasoningEfforts: false }).reasoningEfforts, false);
  for (const reasoningEfforts of [{ ultra: 'ultra' }, { off: null }, { high: null }, { high: 'high', ultra: 'ultra' }, { high: '' }]) {
    assert.throws(() => validateDraft([{ id: 'invalid', reasoningEfforts }]), { code: 'INVALID_PARAMETER' });
  }
  assert.deepEqual(validateDraft([{ id: 'valid', reasoningEfforts: { off: null, high: 'high' } }])[0].reasoningEfforts, { off: null, high: 'high' });
});

test('native save fills selected metadata without changing selection, order, capacities or other routes', () => {
  const next = draft(), before = structuredClone(next);
  const saved = completeNativeModels(next, base, rows);
  assert.deepEqual(saved.providers['openai-codex'].models[1], { id: 'gpt-6.1-sol', name: 'Sol', reasoningEfforts: efforts });
  assert.deepEqual(saved.providers['openai-codex'].models[0], base.providers['openai-codex'].models[0]);
  assert.deepEqual(saved.providers.other, base.providers.other);
  assert.deepEqual(next, before);
  assert.equal(completeNativeModels(base, base, rows), base, 'unselected candidates must not be added');
});

test('existing incomplete model is repaired but explicit capability choices and deletions are preserved', () => {
  const current = draft(), next = structuredClone(current);
  assert.deepEqual(completeNativeModels(next, current, rows).providers['openai-codex'].models[1].reasoningEfforts, efforts);
  for (const value of [false, { high: 'custom-high' }]) {
    next.providers['openai-codex'].models[1].reasoningEfforts = value;
    assert.equal(completeNativeModels(next, current, rows), next);
  }
  current.providers['openai-codex'].models[1].reasoningEfforts = efforts;
  delete next.providers['openai-codex'].models[1].reasoningEfforts;
  assert.equal(completeNativeModels(next, current, rows), next, 'explicit removal must not be undone');
  delete next.providers['openai-codex'].models;
  assert.equal(completeNativeModels(next, current, rows), next, 'reset to inherited catalog must not be undone');
});

test('endpoint, protocol, credential-ref, headers and removed routes prevent cached metadata adoption', () => {
  for (const field of ['baseURL', 'api', 'apiKeyEnv', 'headers']) {
    const next = draft(); next.providers['openai-codex'][field] = field === 'headers' ? { test: 'changed' } : 'changed';
    assert.equal(completeNativeModels(next, base, rows), next);
    const current = structuredClone(base); current.providers['openai-codex'][field] = next.providers['openai-codex'][field];
    assert.equal(completeNativeModels(draft(), current, rows).providers['openai-codex'].models[1].reasoningEfforts, undefined);
  }
  assert.equal(completeNativeModels(draft(), { providers: {} }, rows).providers['openai-codex'].models[1].reasoningEfforts, undefined);
});

test('save wrapper stays inside official edit callback and restores service on disposal', async () => {
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai' } };
  let disk = structuredClone(base), reads = 0, calls = 0;
  class Editor { async edit(given, change) { assert.equal(this, service); calls++; disk = change(disk, {}); } }
  const service = new Editor(), original = service.edit;
  const stop = hookNativeModelSave({ configEditor: service }, { savedCatalogs: async () => { reads++; return rows; } });
  await service.edit(entry, () => draft());
  assert.deepEqual(disk.providers['openai-codex'].models[1].reasoningEfforts, efforts);
  await service.edit({ options: { name: 'other-plugin' } }, () => base);
  assert.equal(reads, 1); assert.equal(calls, 2);
  stop(); assert.equal(service.edit, original); assert.equal(Object.hasOwn(service, 'edit'), false);
  await service.edit(entry, () => draft());
  assert.equal(disk.providers['openai-codex'].models[1].reasoningEfforts, undefined);
});

test('mutating callbacks cannot undo explicit removals; previewed writes remain exact', async () => {
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai' } };
  let current = draft(); current.providers['openai-codex'].models[1].reasoningEfforts = efforts;
  const service = { edit: async (entry, change) => { current = change(current, {}); } };
  const stop = hookNativeModelSave({ configEditor: service }, { savedCatalogs: async () => rows });
  await service.edit(entry, value => { delete value.providers['openai-codex'].models[1].reasoningEfforts; return value; });
  assert.equal(current.providers['openai-codex'].models[1].reasoningEfforts, undefined);
  await service.edit(entry, exactModelEdit(() => draft()));
  assert.deepEqual(current, draft());
  stop();
});

test('later wrapper is preserved and stopped wrapper becomes inert', async () => {
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai' } };
  const service = { edit: async (entry, change) => change(base, {}) };
  const stop = hookNativeModelSave({ configEditor: service }, { savedCatalogs: async () => rows });
  const wrapped = service.edit; service.edit = (...args) => wrapped(...args);
  const later = service.edit; stop(); assert.equal(service.edit, later);
  assert.deepEqual(await service.edit(entry, () => draft()), draft());
});

test('full fetch -> native ID-only adoption -> static save keeps reasoning, never fetches or writes credentials on save', async () => {
  const current = structuredClone(base), entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: current } };
  let account = 'account-one', fetches = 0, writes = 0;
  const ctx = {
    configEditor: { entries: () => [entry], configuration: () => [{ entry, inherited: {} }], async edit(e, change) { writes++; e.options.config = change(e.options.config, {}); } },
    credentials: { readRecord: async () => ({ kind: 'grant', payload: { type: 'oauth', access: account, refresh: 'fixture-refresh', accountId: 'fixture-account', expires: Date.now() + 60000 } }) }
  };
  // Keep this integration focused on Codex, not the intentionally unsupported other route.
  const engine = new ProbeEngine(ctx, { credentialKey: (a, b) => `${a}/${b}` }, { transport: { fetch: async () => { fetches++; return Response.json(vendor); } }, catalogCache: new CatalogCache() });
  const stop = hookNativeModelSave(ctx, engine);
  await engine.refreshForSettings({ provider: 'openai-codex' });
  assert.equal(writes, 0, 'background/native discovery must not silently change selected models');
  await ctx.configEditor.edit(entry, () => draft());
  assert.deepEqual(entry.options.config.providers['openai-codex'].models[1].reasoningEfforts, efforts);
  assert.equal(writes, 1); assert.equal(fetches, 1);
  account = 'account-two';
  entry.options.config = structuredClone(base);
  await ctx.configEditor.edit(entry, () => draft());
  assert.equal(entry.options.config.providers['openai-codex'].models[1].reasoningEfforts, undefined, 'account rotation must invalidate saved metadata');
  assert.equal(fetches, 1);
  stop(); engine.dispose();
});
