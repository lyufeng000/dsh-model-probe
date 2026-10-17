import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argonReasoning, hookGoogleArgon, GOOGLE_ARGON_HOOK } from '../lib/google-argon.js';

const base = { id: 'gemini-4-argon', name: 'Gemini 4 Argon', provider: 'google', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const model = changes => ({ ...base, ...changes });
const levels = { low: 'low', medium: 'medium', high: 'high' };
const originalPayload = () => ({ model: base.id, contents: [], config: { temperature: 0.2, maxOutputTokens: 1234, thinkingConfig: { thinkingBudget: -1, includeThoughts: true, extra: 'preserved' } } });
function fixture() {
  class Models {
    streamSimple(m, context, options) { return { receiver: this, model: m, context, options }; }
  }
  const createModels = () => new Models();
  const instance = createModels();
  const prototype = Object.getPrototypeOf(instance);
  return { createModels, instance, prototype, descriptor: Object.getOwnPropertyDescriptor(prototype, 'streamSimple') };
}

test('Argon capability requires exact provider, id, runtime API and official endpoint', () => {
  assert.deepEqual(argonReasoning(base), levels);
  assert.deepEqual(argonReasoning(model({ baseUrl: 'https://generativelanguage.googleapis.com/v1' }), { api: base.api }), levels);
  for (const changes of [
    { id: 'gemini-4-argon-preview' }, { id: 'Gemini-4-argon' }, { provider: 'gateway' },
    { api: 'google-vertex' }, { api: undefined }, { baseUrl: undefined },
    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/' },
    { baseUrl: 'https://generativelanguage.googleapis.com.evil.invalid/v1beta' },
    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta?key=x' },
    { baseUrl: 'http://generativelanguage.googleapis.com/v1beta' },
  ]) assert.equal(argonReasoning(model(changes)), undefined);
  for (const m of [undefined, null, false, {}, 'gemini-4-argon']) assert.equal(argonReasoning(m), undefined);
  assert.equal(argonReasoning(base, { api: 'openai-completions' }), undefined);
  assert.notEqual(argonReasoning(base), argonReasoning(base));
});

test('hook clones only target options/payload and preserves config, arguments, this and return value', async t => {
  const f = fixture();
  const dispose = hookGoogleArgon(f.createModels);
  t.after(dispose);
  assert.equal(f.prototype.streamSimple[GOOGLE_ARGON_HOOK], true);
  const m = Object.freeze(model({ thinkingLevelMap: Object.freeze({ low: 'HIGH' }) }));
  const context = Object.freeze({ messages: [] });
  const options = Object.freeze({ reasoning: 'low', maxRetries: 3 });
  const call = f.instance.streamSimple(m, context, options);
  assert.equal(call.receiver, f.instance);
  assert.equal(call.model, m);
  assert.equal(call.context, context);
  assert.notEqual(call.options, options);
  assert.equal(call.options.maxRetries, 3);
  const p = originalPayload(), before = structuredClone(p);
  const corrected = await call.options.onPayload(p, m);
  assert.deepEqual(p, before);
  assert.notEqual(corrected, p);
  assert.notEqual(corrected.config, p.config);
  assert.deepEqual(corrected.config, { temperature: 0.2, maxOutputTokens: 1234, thinkingConfig: { includeThoughts: true, extra: 'preserved', thinkingLevel: 'HIGH' } });
});

test('caller callback observes corrected payload, async mutations and replacements remain authoritative', async t => {
  const f = fixture();
  t.after(hookGoogleArgon(f.createModels));
  for (const replacement of [undefined, null, { config: { replacement: true } }]) {
    let observed, receiver, actual;
    const call = f.instance.streamSimple(base, {}, { reasoning: 'medium', async onPayload(p, m) {
      await Promise.resolve();
      observed = p; receiver = this; actual = m;
      p.custom = 'caller mutation';
      assert.equal(p.config.thinkingConfig.thinkingLevel, 'MEDIUM');
      assert.equal(Object.hasOwn(p.config.thinkingConfig, 'thinkingBudget'), false);
      return replacement;
    } });
    const result = await call.options.onPayload(originalPayload(), base);
    assert.equal(receiver, call.options);
    assert.equal(actual, base);
    assert.equal(result, replacement === undefined ? observed : replacement);
    if (replacement === undefined) assert.equal(result.custom, 'caller mutation');
  }
  const sentinel = new Error('CALLER_SENTINEL');
  for (const onPayload of [() => { throw sentinel; }, async () => { throw sentinel; }]) {
    const call = f.instance.streamSimple(base, {}, { reasoning: 'high', onPayload });
    await assert.rejects(call.options.onPayload(originalPayload(), base), error => error === sentinel);
  }
});

test('default is medium, valid aliases work, unsupported selections reject before caller', async t => {
  const f = fixture();
  t.after(hookGoogleArgon(f.createModels));
  const defaultCall = f.instance.streamSimple(base, {});
  assert.equal((await defaultCall.options.onPayload({ config: {} }, base)).config.thinkingConfig.thinkingLevel, 'MEDIUM');
  for (const [reasoning, alias] of Object.entries({ low: 'medium', medium: 'HIGH', high: 'low' })) {
    const m = model({ thinkingLevelMap: { [reasoning]: alias } });
    const call = f.instance.streamSimple(m, {}, { reasoning });
    assert.equal((await call.options.onPayload(originalPayload(), m)).config.thinkingConfig.thinkingLevel, alias.toUpperCase());
  }
  for (const reasoning of ['off', 'minimal', 'xhigh', 'max', 'secret-invalid', null, false, 0, '']) {
    const call = f.instance.streamSimple(base, {}, { reasoning, onPayload() { assert.fail('unsupported input reached caller'); } });
    await assert.rejects(call.options.onPayload(originalPayload(), base), /requires reasoning low, medium, or high/);
  }
  for (const alias of [null, false, {}, 'off', 'minimal', 'secret-invalid']) {
    const m = model({ thinkingLevelMap: { low: alias } });
    const call = f.instance.streamSimple(m, {}, { reasoning: 'low' });
    await assert.rejects(call.options.onPayload(originalPayload(), m), /unsupported thinking-level mapping/);
  }
});

test('non-target calls are identical and post-auth endpoint is checked again', async t => {
  const f = fixture();
  t.after(hookGoogleArgon(f.createModels));
  const options = { reasoning: 'high' };
  for (const changes of [{ id: 'gemini-2.5-pro' }, { api: 'google-vertex' }, { provider: 'gateway' }, { baseUrl: 'https://offline.invalid/v1' }]) {
    const call = f.instance.streamSimple(model(changes), {}, options);
    assert.equal(call.options, options);
  }
  const p = originalPayload();
  for (const actualModel of [undefined, model({ baseUrl: 'https://offline.invalid/v1' }), model({ api: 'google-vertex' })]) {
    let seen;
    const call = f.instance.streamSimple(base, {}, { reasoning: 'off', onPayload(value, actual) { seen = value; assert.equal(actual, actualModel); } });
    assert.equal(await call.options.onPayload(p, actualModel), undefined);
    assert.equal(seen, p);
    assert.equal(p.config.thinkingConfig.thinkingBudget, -1);
  }
});

test('disposal restores descriptor, deactivates retained callbacks and preserves later wrappers', async () => {
  const f = fixture();
  const dispose = hookGoogleArgon(f.createModels);
  const wrapped = f.prototype.streamSimple;
  const queued = f.instance.streamSimple(base, {}, { reasoning: 'high' });
  const second = f.createModels();
  assert.equal((await second.streamSimple(base, {}).options.onPayload(originalPayload(), base)).config.thinkingConfig.thinkingLevel, 'MEDIUM');
  dispose(); dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.prototype, 'streamSimple'), f.descriptor);
  assert.equal(wrapped[GOOGLE_ARGON_HOOK], false);
  assert.equal(await queued.options.onPayload(originalPayload(), base), undefined);
  const options = {};
  assert.equal(wrapped.call(f.instance, base, {}, options).options, options);
  const dispose2 = hookGoogleArgon(f.createModels);
  const prior = f.prototype.streamSimple;
  function later(...args) { return prior.apply(this, args); }
  Object.defineProperty(f.prototype, 'streamSimple', { ...f.descriptor, value: later });
  dispose2();
  assert.equal(f.prototype.streamSimple, later);
  assert.equal(f.instance.streamSimple(base, {}, options).options, options);
});

test('stacked installs can dispose out of order without disabling a live hook', async () => {
  const f = fixture();
  const firstDispose = hookGoogleArgon(f.createModels);
  const first = f.prototype.streamSimple;
  const secondDispose = hookGoogleArgon(f.createModels);
  let count = 0;
  const options = { reasoning: 'low', onPayload() { count++; } };
  firstDispose();
  assert.equal((await f.instance.streamSimple(base, {}, options).options.onPayload(originalPayload(), base)).config.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(count, 1);
  secondDispose();
  assert.equal(f.prototype.streamSimple, first);
  assert.equal(first[GOOGLE_ARGON_HOOK], false);
  assert.equal(f.instance.streamSimple(base, {}, options).options, options);
});

const runtime = process.env.DSH_MODEL_TEST_RUNTIME;
const dist = runtime === undefined ? undefined : join(runtime, 'node_modules/@earendil-works/pi-ai/dist');
const runtimeExists = dist !== undefined && existsSync(join(dist, 'models.js'));
const runtimeSkip = runtimeExists ? false : 'Set DSH_MODEL_TEST_RUNTIME to a DSH 0.2.1-rc.2 runtime with pi-ai 1.1.0';

test('installed ModelsImpl + googleProvider + Google adapter: offline wire conformance', { skip: runtimeSkip, timeout: 30000 }, async t => {
  const load = path => import(pathToFileURL(join(dist, path)).href);
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); };
  t.after(() => { globalThis.fetch = previousFetch; assert.equal(networkCalls, 0); });
  const { createModels } = await load('models.js');
  const { googleProvider } = await load('providers/google.js');
  const { streamSimple: rawSimple } = await load('api/google-generative-ai.js');
  const newModels = () => {
    const instance = createModels({ authContext: { env: async () => { throw new Error('ENV_FORBIDDEN'); }, fileExists: async () => { throw new Error('FILES_FORBIDDEN'); } } });
    instance.setProvider(googleProvider());
    return instance;
  };
  const instance = newModels();
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'offline serialization fixture' }], timestamp: 0 }] };
  const requestOptions = { apiKey: 'offline-fixture-not-a-credential', env: {}, maxRetries: 0, fetch: globalThis.fetch, temperature: 0.2 };
  async function payload(m, reasoning, target = instance) {
    let captured, actual;
    const options = { ...requestOptions, reasoning, async onPayload(p, a) { await Promise.resolve(); captured = p; actual = a; throw new Error('STOP_AT_PAYLOAD'); } };
    const stream = target === rawSimple ? rawSimple(m, context, options) : target.streamSimple(m, context, options);
    const result = await stream.result();
    assert.match(result.errorMessage, /STOP_AT_PAYLOAD/);
    assert.ok(captured);
    return { captured, actual };
  }
  const unpatched = await payload(base, 'low');
  assert.equal(unpatched.captured.config.thinkingConfig.thinkingBudget, -1);
  const dispose = hookGoogleArgon(createModels);
  t.after(dispose);
  await t.test('three distinct levels and default medium preserve model and config', async () => {
    for (const reasoning of ['low', 'medium', 'high', undefined]) {
      const snapshot = structuredClone(base);
      const { captured, actual } = await payload(base, reasoning);
      assert.equal(captured.config.thinkingConfig.thinkingLevel, (reasoning ?? 'medium').toUpperCase());
      assert.equal(Object.hasOwn(captured.config.thinkingConfig, 'thinkingBudget'), false);
      assert.equal(captured.config.temperature, 0.2);
      if (reasoning) assert.equal(captured.config.thinkingConfig.includeThoughts, true);
      assert.equal(captured.model, base.id);
      assert.equal(actual.id, base.id);
      assert.deepEqual(base, snapshot);
    }
    const otherInstance = newModels();
    assert.equal((await payload(base, 'high', otherInstance)).captured.config.thinkingConfig.thinkingLevel, 'HIGH');
  });
  await t.test('real adapter honors explicit supported map aliases', async () => {
    for (const [reasoning, alias] of Object.entries({ low: 'HIGH', medium: 'low', high: 'MEDIUM' })) {
      const m = model({ thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null, [reasoning]: alias } });
      assert.equal((await payload(m, reasoning)).captured.config.thinkingConfig.thinkingLevel, alias.toUpperCase());
    }
  });
  await t.test('off and unsupported input fail as stream errors before dispatch or caller', async () => {
    for (const reasoning of ['off', 'minimal', 'xhigh', 'max', 'invalid', null, false, '']) {
      const result = await instance.streamSimple(base, context, { ...requestOptions, reasoning, onPayload() { assert.fail('invalid selection reached caller'); } }).result();
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, /requires reasoning low, medium, or high/);
    }
  });
  await t.test('unsupported map values never dispatch; native adapter validation remains intact', async () => {
    for (const alias of [null, false, {}, 'off', 'minimal', 'invalid']) {
      const m = model({ thinkingLevelMap: { low: alias } });
      const result = await instance.streamSimple(m, context, { ...requestOptions, reasoning: 'low', onPayload() { assert.fail('invalid mapping reached caller'); } }).result();
      assert.equal(result.stopReason, 'error');
      // Some invalid strings fail the native serializer before onPayload;
      // keep that existing validation rather than rewriting model/options.
      assert.match(result.errorMessage, /unsupported thinking-level mapping|Unsupported Google thinking level mapping/);
    }
  });
  await t.test('other models, endpoints and APIs retain original serialized payload', async () => {
    for (const changes of [{ id: 'gemini-2.5-pro' }, { id: 'gemini-3.8-flash' }, { api: 'google-vertex' }, { baseUrl: 'https://offline.invalid/v1' }]) {
      const m = model(changes);
      assert.deepEqual((await payload(m, 'high')).captured, (await payload(m, 'high', rawSimple)).captured);
    }
  });
  await t.test('auth URL override is respected without applying official correction cross-domain', async () => {
    const redirected = newModels();
    const provider = googleProvider();
    provider.auth = { apiKey: { resolve: async () => ({ auth: { apiKey: 'offline-fixture-not-a-credential', baseUrl: 'https://offline.invalid/v1' }, source: 'offline fixture' }) } };
    redirected.setProvider(provider);
    const { captured, actual } = await payload(base, 'low', redirected);
    assert.equal(actual.baseUrl, 'https://offline.invalid/v1');
    assert.equal(captured.config.thinkingConfig.thinkingBudget, -1);
    assert.equal(captured.config.thinkingConfig.thinkingLevel, undefined);
  });
  await t.test('async replacement reaches SDK unchanged without any network call', async () => {
    // Reading replacement.model is the SDK boundary. A sentinel getter stops
    // locally, proving replacement return semantics through the real adapter.
    let observed = false, replacementRead = false;
    const replacement = { get model() { replacementRead = true; throw new Error('STOP_AT_REPLACEMENT'); } };
    const result = await instance.streamSimple(base, context, { ...requestOptions, reasoning: 'low', async onPayload(p) {
      await Promise.resolve();
      observed = p.config.thinkingConfig.thinkingLevel === 'LOW';
      return replacement;
    } }).result();
    assert.equal(observed, true);
    assert.equal(replacementRead, true);
    assert.match(result.errorMessage, /STOP_AT_REPLACEMENT/);
  });
  await t.test('dispose returns installed adapter to its original budget path', async () => {
    dispose();
    assert.equal((await payload(base, 'high')).captured.config.thinkingConfig.thinkingBudget, -1);
  });
});
