import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogReasoning, listingReasoning } from '../lib/reasoning.js';
import { reasoningFields, THINKING_LEVELS } from '../lib/model.js';

const base = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-responses', reasoning: true, baseUrl: 'https://offline.invalid/v1', input: ['text'], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const basic = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' };
const model = changes => ({ ...base, ...changes });
const catalog = changes => catalogReasoning(model(changes));
const toggleModel = model({ api: 'openai-completions', provider: 'moonshotai-cn', compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false } });

// The DSH resolver writes a complete map. off:null intentionally stays absent.
function savedModel(original, fields = catalogReasoning(original)) {
  assert.ok(fields && typeof fields === 'object');
  const thinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(fields, level)) thinkingLevelMap[level] = null;
    else if (fields[level] !== null) thinkingLevelMap[level] = fields[level];
  }
  return { ...original, reasoning: true, thinkingLevelMap };
}

test('catalog false, unknown, malformed and protocol isolation', () => {
  assert.equal(catalogReasoning(undefined), undefined);
  assert.equal(catalog({ reasoning: false }), false);
  assert.equal(catalog({ reasoning: undefined }), undefined);
  assert.equal(catalog({ reasoning: 'true' }), undefined);
  assert.equal(catalog({ api: 'future-api' }), undefined);
  assert.equal(catalogReasoning(model({}), { api: 'openai-completions' }), undefined);
  assert.equal(catalogReasoning(model({ reasoning: false }), { api: 'anthropic-messages' }), undefined);
  for (const thinkingLevelMap of [null, [], true, 'high']) assert.equal(catalog({ thinkingLevelMap }), undefined);
});

test('responses base defaults, unsupported nulls, missing off and wire aliases', () => {
  assert.deepEqual(catalog({}), basic);
  assert.deepEqual(catalog({ thinkingLevelMap: { minimal: null, low: 'small', medium: null, high: 'big', xhigh: 'maximum', max: null } }), { off: null, low: 'small', high: 'big', xhigh: 'maximum' });
  assert.deepEqual(catalog({ thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high' } }), { off: 'none', high: 'high' });
  assert.deepEqual(catalog({ thinkingLevelMap: { off: null } }), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' });
  assert.equal(catalog({ thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map(x => [x, null])) }), undefined);
  assert.deepEqual(catalog({ thinkingLevelMap: { minimal: {}, low: 2, medium: 'bad alias', high: 'high', xhigh: false } }), { off: null, high: 'high' });
});

test('Moonshot toggle only, mandatory toggle and real Kimi K3 efforts', () => {
  assert.deepEqual(catalogReasoning(toggleModel), { off: null, high: 'high' });
  assert.deepEqual(catalogReasoning({ ...toggleModel, thinkingLevelMap: { off: null } }), { high: 'high' });
  assert.deepEqual(catalog({ api: 'openai-completions', provider: 'moonshotai-cn', compat: { thinkingFormat: 'openai', supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } }), { low: 'low', high: 'high', max: 'max' });
});

test('xAI is protocol specific: responses supports efforts, no provider-wide toggle', () => {
  const map = { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null };
  assert.deepEqual(catalog({ provider: 'xai', thinkingLevelMap: map }), { off: 'none', low: 'low', medium: 'medium', high: 'high' });
  assert.equal(catalog({ provider: 'xai', api: 'openai-completions' }), undefined);
  assert.deepEqual(catalog({ provider: 'xai', api: 'openai-completions', compat: { supportsReasoningEffort: true } }), basic);
});

test('completion toggles do not masquerade as four effort levels; budgets are distinct', () => {
  for (const thinkingFormat of ['zai', 'qwen', 'deepseek', 'qwen-chat-template', 'together']) {
    assert.deepEqual(catalog({ api: 'openai-completions', compat: { thinkingFormat, supportsReasoningEffort: false } }), { off: null, high: 'high' });
  }
  assert.deepEqual(catalog({ api: 'openai-completions', compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false, supportsThinkingTokenBudget: true } }), basic);
  assert.deepEqual(catalog({ api: 'openai-completions', provider: 'openrouter' }), basic);
  assert.equal(catalog({ api: 'openai-completions', compat: { thinkingFormat: 'ant-ling' } }), undefined);
});

test('budget-only completions and omitWhenOff templates do not falsely advertise disable', () => {
  const fields = { api: 'openai-completions', compat: { supportsReasoningEffort: false, supportsThinkingTokenBudget: true } };
  assert.deepEqual(catalog(fields), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' });
  assert.deepEqual(catalog({ api: 'openai-completions', compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { think: { $var: 'thinking.enabled', omitWhenOff: true } } } }), { high: 'high' });
  assert.deepEqual(catalog({ api: 'openai-completions', compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { think: { $var: 'thinking.enabled' } } } }), { off: null, high: 'high' });
});

test('Anthropic adaptive minimal defaults low; explicit aliases survive; managed effort has no off', () => {
  assert.deepEqual(catalog({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } }), { ...basic, minimal: 'low' });
  assert.deepEqual(catalog({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true }, thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' } }), { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  assert.deepEqual(catalog({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { minimal: 'low', low: 'medium', medium: null, high: 'high' } }), { off: null, minimal: 'low', low: 'medium', high: 'high' });
});

test('Anthropic budget adapter ignores map aliases and clamps extended levels, not identity effort', () => {
  assert.deepEqual(catalog({ api: 'anthropic-messages', thinkingLevelMap: { low: 'high', xhigh: 'xhigh', max: 'max' } }), basic);
  assert.deepEqual(catalog({ api: 'anthropic-messages', maxTokens: 3000 }), { off: null, minimal: 'minimal', low: 'low' });
  assert.deepEqual(catalog({ api: 'anthropic-messages', thinkingLevelMap: { off: null } }), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' });
});

test('Google exact adapter family matching, budget aliases, no future-family guesses', () => {
  for (const api of ['google-generative-ai', 'google-vertex']) {
    assert.deepEqual(catalog({ api, id: 'gemini-2.5-pro', thinkingLevelMap: { off: null } }), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' });
    assert.deepEqual(catalog({ api, id: 'gemini-3.8-flash', thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' } }), { low: 'low', medium: 'medium', high: 'high' });
    assert.equal(catalog({ api, id: 'gemini-4-argon' }), undefined);
    assert.equal(catalog({ api, id: 'gemini-3.8-unknown' }), undefined);
    assert.deepEqual(catalog({ api, id: 'gemini-2.5-flash', thinkingLevelMap: { minimal: 'LOW', low: 'low', medium: null, high: 'high' } }), { off: null, minimal: 'LOW', high: 'high' });
    assert.deepEqual(catalog({ api, id: 'gemma4-31b', thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'HIGH', max: 'invalid' } }), { off: null, high: 'HIGH' });
  }
});

test('Bedrock Claude adaptive/budget semantics; non-Claude reasoning remains unknown', () => {
  assert.deepEqual(catalog({ api: 'bedrock-converse-stream', id: 'us.anthropic.claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' }), basic);
  assert.deepEqual(catalog({ api: 'bedrock-converse-stream', id: 'us.anthropic.claude-opus-4-6', name: 'Claude Opus 4.6' }), { ...basic, minimal: 'low' });
  assert.equal(catalog({ api: 'bedrock-converse-stream', id: 'amazon.nova', name: 'Nova' }), undefined);
});

test('Mistral prompt-mode collapses to one toggle; effort mode preserves explicit levels', () => {
  assert.deepEqual(catalog({ api: 'mistral-conversations', id: 'magistral-medium' }), { off: null, high: 'high' });
  assert.deepEqual(catalog({ api: 'mistral-conversations', id: 'mistral-medium-latest' }), { off: null, high: 'high' });
  assert.deepEqual(catalog({ api: 'mistral-conversations', id: 'mistral-medium-latest', thinkingLevelMap: { high: null } }), { off: null, medium: 'high' });
  assert.deepEqual(catalog({ api: 'mistral-conversations', id: 'mistral-medium-latest', thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high' } }), { off: null, low: 'low', high: 'high' });
});

test('Codex list accepts effort objects and strings, not generic capability guesses', () => {
  assert.deepEqual(listingReasoning({ supported_reasoning_levels: [{ effort: 'low' }, 'high', { effort: 'xhigh' }, { effort: 'ultra' }, null, 2] }, 'openai-codex-responses'), { low: 'low', high: 'high', xhigh: 'xhigh' });
  assert.equal(listingReasoning({ supported_reasoning_levels: 'high' }, 'openai-codex-responses'), undefined);
  assert.equal(listingReasoning({ supported_reasoning_levels: ['low'] }, 'anthropic-messages'), undefined);
});

test('Anthropic documented supported objects, not truthy booleans', () => {
  const raw = { capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false }, xhigh: true }, thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: true } } } } };
  assert.deepEqual(listingReasoning(raw, 'anthropic-messages'), { off: null, low: 'low', high: 'high' });
  assert.equal(listingReasoning({ capabilities: { effort: { supported: true, low: true } } }, 'anthropic-messages'), undefined);
  assert.equal(listingReasoning({ capabilities: { effort: { supported: false } } }, 'anthropic-messages'), undefined);
  assert.equal(listingReasoning({ capabilities: { effort: { supported: false }, thinking: { supported: false } } }, 'anthropic-messages'), false);
});

test('Anthropic effort false does not suppress real budget thinking; adaptive alone gives no invented levels', () => {
  const raw = { capabilities: { effort: { supported: false }, thinking: { supported: true, types: { enabled: { supported: true }, disabled: { supported: true } } } } };
  assert.deepEqual(listingReasoning(raw, 'anthropic-messages'), basic);
  raw.capabilities.thinking.types.disabled.supported = false;
  assert.deepEqual(listingReasoning(raw, 'anthropic-messages'), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' });
  assert.equal(listingReasoning({ capabilities: { thinking: { types: { adaptive: { supported: true } } } } }, 'anthropic-messages'), undefined);
  assert.equal(listingReasoning({ capabilities: { thinking: { enabled: true, adaptive: true, disabled: true } } }, 'anthropic-messages'), undefined);
});

test('xAI exact reasoning_effort arrays; Google thinking is boolean evidence only', () => {
  assert.deepEqual(listingReasoning({ capabilities: { reasoning_effort: ['none', 'low', 'high'] } }, 'openai-responses'), { off: 'none', low: 'low', high: 'high' });
  for (const invalid of [true, false, null, 'high', { low: true }, [{ effort: 'high' }]]) assert.equal(listingReasoning({ capabilities: { reasoning_effort: invalid } }, 'openai-responses'), undefined);
  for (const api of ['google-generative-ai', 'google-vertex']) {
    assert.equal(listingReasoning({ thinking: false }, api), false);
    for (const thinking of [true, undefined, null, 'false', { supported: true }]) assert.equal(listingReasoning({ thinking }, api), undefined);
  }
});

test('OpenRouter exact, null=all, missing=unknown, none keeps wire spelling, mandatory removes off', () => {
  assert.deepEqual(listingReasoning({ reasoning: { supported_efforts: ['none', 'low', 'high'] } }, 'openai-completions'), { off: 'none', low: 'low', high: 'high' });
  assert.deepEqual(listingReasoning({ reasoning: { supported_efforts: null } }, 'openai-completions'), { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  assert.deepEqual(listingReasoning({ reasoning: { supported_efforts: ['none', 'high'], mandatory: true } }, 'openai-completions'), { high: 'high' });
  assert.deepEqual(listingReasoning({ reasoning: { supported_efforts: ['off', 'high'] } }, 'openai-completions'), { high: 'high' });
  for (const raw of [{}, { reasoning: {} }, { supported_parameters: ['reasoning'] }, { reasoning: { supported_efforts: [] } }, { reasoning: { supported_efforts: 'high' } }, { reasoning: { supported_efforts: ['none'] } }]) assert.equal(listingReasoning(raw, 'openai-completions'), undefined);
});

test('OpenRouter gateway none never leaks into Anthropic Messages protocol', () => {
  const raw = { id: 'anthropic/claude-opus-5.5', reasoning: { supported_efforts: null }, supported_parameters: ['reasoning'] };
  assert.equal(listingReasoning(raw, 'anthropic-messages'), undefined);
  assert.deepEqual(catalog({ api: 'anthropic-messages', provider: 'openrouter', id: raw.id, compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }), { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
});

test('all returns are static safe DSH fields; neither function mutates input', () => {
  const original = structuredClone(toggleModel), raw = { reasoning: { supported_efforts: ['none', 'high'] } }, snapshot = structuredClone(raw);
  for (const value of [catalogReasoning(original), listingReasoning(raw, 'openai-completions')]) {
    assert.deepEqual(reasoningFields(value), value);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  }
  assert.deepEqual(original, toggleModel);
  assert.deepEqual(raw, snapshot);
  for (const raw of [null, false, [], 1, 'model']) assert.equal(listingReasoning(raw, 'openai-completions'), undefined);
});

// Optional offline conformance tests. No actual credentials, config, or model
// inference is read/sent. A throwing onPayload stops before network dispatch;
// global fetch is also blocked. This works without installing test dependencies.
const runtime = process.env.DSH_MODEL_TEST_RUNTIME;
const runtimeAnchor = runtime === undefined ? undefined : join(runtime, 'package.json');
const runtimeExists = runtimeAnchor !== undefined && existsSync(runtimeAnchor);
// The plugin targets DSH 0.2.1-rc.2 + pi-ai 1.1.0. Older runtimes keep the historical
// assertions below but are no longer the default; no machine-specific temp path is used.
const piAiVersion = runtimeExists ? JSON.parse(readFileSync(join(runtime, 'node_modules/@earendil-works/pi-ai/package.json'), 'utf8')).version : undefined;
const levelMapReasoning = Number.parseInt(piAiVersion, 10) >= 1;
const runtimeSkip = runtimeExists ? false : 'Set DSH_MODEL_TEST_RUNTIME to a DSH 0.2.1-rc.2 runtime with pi-ai 1.1.0';
const inventoryPath = process.env.DSH_MODEL_TEST_INVENTORY;
const inventoryExists = typeof inventoryPath === 'string' && existsSync(inventoryPath);

test('installed inventory: every confirmed builtin snapshots safely without protocol confusion', { skip: inventoryExists ? false : 'Set DSH_MODEL_TEST_INVENTORY to a reasoning inventory JSON file' }, () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  for (const { route, id, builtin } of inventory) {
    const value = catalogReasoning(builtin);
    if (!builtin) { assert.equal(value, undefined, `${route}/${id}`); continue; }
    assert.ok(value && typeof value === 'object', `${route}/${id}`);
    assert.deepEqual(reasoningFields(value), value);
    if (route.startsWith('moonshot') && id.startsWith('kimi-k2.')) assert.equal(Object.keys(value).filter(x => x !== 'off').length, 1);
    if (route === 'xai') assert.ok(value.low && value.high);
    if (builtin.api === 'anthropic-messages') assert.notEqual(value.off, 'none');
  }
});

test('actual pi-ai adapters: stop at onPayload, verify wire and DSH roundtrip, no network', { skip: runtimeSkip, timeout: 30000 }, async t => {
  const load = name => import(pathToFileURL(join(runtime, 'node_modules/@earendil-works/pi-ai/dist/api', `${name}.js`)).href);
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); };
  t.after(() => { globalThis.fetch = previousFetch; assert.equal(networkCalls, 0); });
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'offline serialization fixture' }], timestamp: 0 }] };
  async function payload(m, level) {
    let captured;
    const api = await load(m.api);
    const apiKey = m.api === 'openai-codex-responses' ? `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-fixture' } })).toString('base64url')}.test` : 'offline-fixture-not-a-credential';
    const stream = api.streamSimple(m, context, { reasoning: level === 'off' ? undefined : level, apiKey, env: {}, cacheRetention: 'none', maxRetries: 0, transport: 'sse', fetch: globalThis.fetch, onPayload(value) { captured = value; throw new Error('STOP_AT_PAYLOAD'); } });
    const result = await stream.result();
    assert.ok(captured, `${m.api}/${m.id}/${level}: ${result.errorMessage}`);
    assert.match(result.errorMessage, /STOP_AT_PAYLOAD/);
    return captured;
  }
  await t.test('Moonshot all original enabled levels are identical, snapshot offers one', async () => {
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      const p = await payload(toggleModel, level);
      assert.deepEqual(p.thinking, { type: 'enabled' });
      assert.equal(p.reasoning_effort, undefined);
    }
    const saved = savedModel(toggleModel);
    assert.deepEqual((await payload(saved, 'off')).thinking, { type: 'disabled' });
    assert.deepEqual((await payload(saved, 'high')).thinking, { type: 'enabled' });
  });
  await t.test('mandatory Moonshot does not serialize disabled, K3 sends true effort', async () => {
    const mandatory = { ...toggleModel, thinkingLevelMap: { off: null } };
    assert.equal((await payload(savedModel(mandatory), 'off')).thinking, undefined);
    const kimi = model({ api: 'openai-completions', provider: 'moonshotai-cn', compat: { thinkingFormat: 'openai', supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } });
    for (const level of ['low', 'high', 'max']) assert.equal((await payload(savedModel(kimi), level)).reasoning_effort, level);
  });
  await t.test('Responses xAI, Codex and aliases survive static declaration', async () => {
    for (const api of ['openai-responses', 'openai-codex-responses']) {
      const m = model({ api, provider: api === 'openai-responses' ? 'xai' : 'openai-codex', thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: 'xhigh' } });
      for (const level of ['off', 'low', 'high', 'xhigh']) assert.equal((await payload(savedModel(m), level)).reasoning.effort, level === 'off' ? 'none' : level);
    }
  });
  await t.test('Responses missing off emits native none and genuine mapped wire aliases survive', async () => {
    const m = model({ thinkingLevelMap: { low: 'minimal', high: 'max' } });
    assert.equal(catalogReasoning(m).off, null);
    assert.equal((await payload(savedModel(m), 'off')).reasoning.effort, 'none');
    assert.equal((await payload(savedModel(m), 'low')).reasoning.effort, 'minimal');
    assert.equal((await payload(savedModel(m), 'high')).reasoning.effort, 'max');
  });
  await t.test('Mistral prompt-mode switch and effort default high match actual adapter', async () => {
    const prompt = model({ api: 'mistral-conversations', id: 'magistral-medium' });
    const effort = model({ api: 'mistral-conversations', id: 'mistral-medium-latest' });
    if (levelMapReasoning) {
      // pi-ai 1.x chooses reasoning_effort from thinkingLevelMap presence, not model id.
      // DSH always materializes the map when reasoningEfforts is declared, while a raw
      // catalog model without a map still uses the legacy prompt_mode switch.
      const mapped = await payload(savedModel(prompt), 'high');
      assert.equal(mapped.reasoningEffort, 'high');
      assert.equal(mapped.promptMode, undefined);
      const legacy = await payload(prompt, 'high');
      assert.equal(legacy.promptMode, 'reasoning');
      assert.equal(legacy.reasoningEffort, undefined);
      assert.equal((await payload(savedModel(effort), 'high')).reasoningEffort, 'high');
      assert.equal((await payload(savedModel(effort), 'minimal')).reasoningEffort, 'high');
    } else {
      // Mistral's onPayload precedes its camelCase -> snake_case wire rename.
      assert.equal((await payload(savedModel(prompt), 'high')).promptMode, 'reasoning');
      assert.equal((await payload(savedModel(prompt), 'off')).promptMode, undefined);
      assert.equal((await payload(savedModel(effort), 'high')).reasoningEffort, 'high');
      assert.equal((await payload(effort, 'minimal')).reasoningEffort, 'high');
    }
  });
  await t.test('Anthropic budget is numeric, adaptive minimal maps low, managed effort is message-scoped', async () => {
    const budget = model({ api: 'anthropic-messages' });
    for (const [level, tokens] of Object.entries({ minimal: 1024, low: 2048, medium: 8192, high: 16384 })) assert.equal((await payload(savedModel(budget), level)).thinking.budget_tokens, tokens);
    assert.equal((await payload(savedModel(budget), 'off')).thinking.type, 'disabled');
    const adaptive = model({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } });
    assert.equal((await payload(adaptive, 'minimal')).output_config.effort, 'low');
    assert.equal((await payload(savedModel(adaptive), 'minimal')).output_config.effort, 'low');
    const managed = { ...adaptive, provider: 'openrouter', compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true } };
    const p = await payload(savedModel(managed), 'low');
    assert.equal(p.thinking.type, 'adaptive');
    assert.ok(p.messages.some(message => message.output_config?.effort === 'low'));
    assert.equal(catalogReasoning(managed).off, undefined);
  });
  await t.test('Google budgets vs discrete levels and actual off serialization', async () => {
    for (const [id, budgets] of [['gemini-2.5-pro', [128, 2048, 8192, 32768]], ['gemini-2.5-flash-lite', [512, 2048, 8192, 24576]], ['gemini-2.5-flash', [128, 2048, 8192, 24576]]]) {
      const m = model({ api: 'google-generative-ai', id });
      for (const [index, level] of ['minimal', 'low', 'medium', 'high'].entries()) assert.equal((await payload(savedModel(m), level)).config.thinkingConfig.thinkingBudget, budgets[index]);
      assert.equal((await payload(savedModel(m), 'off')).config.thinkingConfig.thinkingBudget, 0);
    }
    const m = model({ api: 'google-generative-ai', id: 'gemini-3.8-flash', thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' } });
    for (const level of ['low', 'medium', 'high']) assert.equal((await payload(savedModel(m), level)).config.thinkingConfig.thinkingLevel, level.toUpperCase());
    assert.equal((await payload(savedModel(m), 'off')).config.thinkingConfig.thinkingLevel, 'LOW');
    assert.equal(catalogReasoning(m).off, undefined);
  });
  await t.test('gateway none stays none, not omitted off; no synthetic effort on budget toggle', async () => {
    const m = model({ api: 'openai-completions', provider: 'openrouter' });
    const saved = savedModel(m, listingReasoning({ reasoning: { supported_efforts: ['none', 'high'] } }, m.api));
    assert.equal((await payload(saved, 'off')).reasoning.effort, 'none');
    const budget = { ...toggleModel, compat: { ...toggleModel.compat, supportsThinkingTokenBudget: true } };
    for (const [level, value] of Object.entries({ minimal: 1024, low: 2048, medium: 8192, high: 16384 })) assert.equal((await payload(savedModel(budget), level)).thinking_token_budget, value);
  });
});
