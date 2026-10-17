import { object, reasoningFields, THINKING_LEVELS } from './model.js';

const BASE = ['minimal', 'low', 'medium', 'high'];
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const GATEWAY = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const OPENAI = ['openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses'];
const BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const wire = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f\x7f]/u.test(value);
const identity = level => level;

// pi-ai's missing base keys mean supported; missing extended keys do not.
function supported(model, level) {
  const map = model.thinkingLevelMap;
  if (own(map, level) && map[level] !== undefined) return wire(map[level]);
  return level !== 'xhigh' && level !== 'max';
}
function off(model) {
  return supported(model, 'off') ? { off: model.thinkingLevelMap?.off ?? null } : {};
}
function mapped(model, level, fallback = identity) {
  return model.thinkingLevelMap?.[level] ?? fallback(level);
}
function efforts(model, fallback = identity, { allowOff = true, onlyExplicit = false } = {}) {
  const out = allowOff ? off(model) : {};
  for (const level of THINKING_LEVELS.slice(1)) {
    if (supported(model, level) && (!onlyExplicit || wire(model.thinkingLevelMap?.[level]))) out[level] = mapped(model, level, fallback);
  }
  return reasoningFields(out);
}
function toggle(model, allowOff = true) {
  // All enabled levels serialize the SAME switch, not distinct effort controls.
  const level = ['high', 'medium', 'low', 'minimal', 'xhigh', 'max'].find(level => supported(model, level));
  if (!level) return undefined;
  return reasoningFields({ ...(allowOff ? off(model) : {}), [level]: mapped(model, level) });
}
function budgets(model, values = BUDGETS, { google = false, allowOff = true } = {}) {
  const out = allowOff ? off(model) : {};
  const seen = new Set();
  for (const level of THINKING_LEVELS.slice(1)) {
    if (!supported(model, level)) continue;
    // Anthropic/Chat budgets use the UI level, NOT thinkingLevelMap. Google's
    // adapter resolves aliases first, and rejects anything outside BASE.
    const target = google ? String(mapped(model, level)).toLowerCase() : BASE.includes(level) ? level : 'high';
    if (!BASE.includes(target)) continue;
    let amount = values[target];
    if (!google && Number.isFinite(model.maxTokens)) amount = Math.min(amount, Math.max(0, model.maxTokens - 1024));
    if (!(amount > 0) || seen.has(amount)) continue;
    seen.add(amount);
    out[level] = google ? mapped(model, level) : target;
  }
  return reasoningFields(out);
}

// These defaults mirror dist/api/openai-completions.js detectCompat, not a
// provider-wide heuristic: e.g. xAI Responses must never enter this branch.
function completionCompat(model) {
  const p = model.provider, url = typeof model.baseUrl === 'string' ? model.baseUrl : '';
  const zai = ['zai', 'zai-coding-cn'].includes(p) || url.includes('api.z.ai') || url.includes('open.bigmodel.cn');
  const together = p === 'together' || url.includes('api.together.ai') || url.includes('api.together.xyz');
  const moonshot = ['moonshotai', 'moonshotai-cn'].includes(p) || url.includes('api.moonshot.');
  const router = p === 'openrouter' || url.includes('openrouter.ai');
  const ant = p === 'ant-ling' || url.includes('api.ant-ling.com');
  const deepseek = p === 'deepseek' || url.toLowerCase().includes('deepseek.com');
  const unsupported = zai || together || moonshot || ant || p === 'xai' || url.includes('api.x.ai') || p === 'nvidia' || url.includes('integrate.api.nvidia.com') || p === 'cloudflare-ai-gateway' || url.includes('gateway.ai.cloudflare.com');
  const compat = object(model.compat) ? model.compat : {};
  return { ...compat, supportsReasoningEffort: compat.supportsReasoningEffort ?? !unsupported,
    thinkingFormat: compat.thinkingFormat ?? (deepseek ? 'deepseek' : zai ? 'zai' : together ? 'together' : ant ? 'ant-ling' : router ? 'openrouter' : 'openai') };
}
function completionReasoning(model) {
  const c = completionCompat(model), format = c.thinkingFormat;
  const templates = format === 'baseten' ? c.chatTemplateArgs : c.chatTemplateKwargs;
  const variables = ['baseten', 'chat-template'].includes(format) && object(templates) ? Object.values(templates).filter(object) : [];
  const budget = c.supportsThinkingTokenBudget === true || wire(c.thinkingTokenBudgetField) || variables.some(v => v.$var === 'thinking.budget');
  // The template resolver treats every variable other than enabled/budget as
  // an effort selector. Restrict detection to its documented effort variable.
  const sendsEffort = ['openrouter', 'string-thinking'].includes(format) || (c.supportsReasoningEffort === true && !['qwen-chat-template', 'chat-template', 'ant-ling'].includes(format)) || variables.some(v => v.$var === 'thinking.effort');
  const sendsToggle = ['deepseek', 'zai', 'qwen', 'qwen-chat-template', 'together'].includes(format) || variables.some(v => v.$var === 'thinking.enabled');
  const disablesToggle = ['deepseek', 'zai', 'qwen', 'qwen-chat-template', 'together'].includes(format) || variables.some(v => v.$var === 'thinking.enabled' && !v.omitWhenOff);
  if (format === 'ant-ling') return efforts(model, identity, { allowOff: false, onlyExplicit: true });
  if (sendsEffort) return efforts(model);
  // Omitting a budget alone does NOT establish that thinking can be disabled.
  if (budget) return budgets(model, BUDGETS, { allowOff: disablesToggle });
  if (sendsToggle) return toggle(model, disablesToggle);
  return undefined;
}
function googleReasoning(model) {
  const id = model.id.toLowerCase();
  // Exact installed usesGoogleThinkingLevel predicate; do not extrapolate to
  // every Gemini 3+, or fabricate levels for a future unknown Gemini family.
  const discrete = /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) || id === 'gemini-flash-latest' || id === 'gemini-flash-lite-latest' || /gemma-?4/.test(id);
  if (discrete) {
    const out = off(model);
    for (const level of THINKING_LEVELS.slice(1)) {
      if (supported(model, level) && BASE.includes(String(mapped(model, level)).toLowerCase())) out[level] = mapped(model, level);
    }
    return reasoningFields(out);
  }
  // getGoogleBudget uses case-sensitive includes, in this exact order.
  const name = model.id;
  if (name.includes('2.5-pro')) return budgets(model, { minimal: 128, low: 2048, medium: 8192, high: 32768 }, { google: true });
  if (name.includes('2.5-flash-lite')) return budgets(model, { minimal: 512, low: 2048, medium: 8192, high: 24576 }, { google: true });
  if (name.includes('2.5-flash')) return budgets(model, { minimal: 128, low: 2048, medium: 8192, high: 24576 }, { google: true });
  // The runtime fallback is a single automatic budget (-1), not four levels.
  return undefined;
}
function bedrockReasoning(model) {
  const id = model.id.toLowerCase(), name = (model.name ?? '').toLowerCase();
  if (![id, name].some(s => s.includes('anthropic.claude') || s.includes('anthropic/claude')) && !name.includes('claude')) return undefined;
  const candidates = [id, name].flatMap(s => [s, s.replace(/[\s_.:]+/g, '-')]);
  const adaptive = candidates.some(s => ['opus-4-6', 'opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-4-6', 'sonnet-5', 'fable-5'].some(v => s.includes(v)));
  if (!adaptive) return budgets(model);
  const result = efforts(model, level => level === 'minimal' ? 'low' : BASE.includes(level) ? level : 'high');
  if (result?.xhigh && candidates.some(s => ['opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-5', 'fable-5'].some(v => s.includes(v)))) result.xhigh = 'xhigh';
  return result;
}

/**
 * Snapshot a CONFIRMED, original pi-ai builtin Model, not a configured stub.
 * Return the DSH reasoningEfforts field itself: false / undefined / a map.
 * Unknown stays unknown. The caller must preserve the builtin compat and must
 * not copy this capability to a route that uses another wire protocol.
 * Budget strings are pi selector names, not literal numeric token budgets.
 * Implemented against the installed pi-ai adapters (2026-10-17).
 */
export function catalogReasoning(model, { api } = {}) {
  if (!object(model) || typeof model.api !== 'string' || (api !== undefined && api !== model.api)) return undefined;
  if (model.reasoning === false) return false;
  if (model.reasoning !== true || typeof model.id !== 'string') return undefined;
  if (model.thinkingLevelMap !== undefined && !object(model.thinkingLevelMap)) return undefined;
  switch (model.api) {
    case 'openai-completions': return completionReasoning(model);
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses': return efforts(model);
    case 'anthropic-messages':
      if (model.compat?.forceAdaptiveThinking === true) {
        return efforts(model, level => level === 'minimal' ? 'low' : BASE.includes(level) ? level : 'high', { allowOff: model.compat?.supportsMidConvoEffort !== true });
      }
      // Without adaptive mode, a managed-effort model always sends high; a
      // map alone cannot turn it into an effort-selectable model.
      if (model.compat?.supportsMidConvoEffort === true) return toggle(model, false);
      return budgets(model);
    case 'google-generative-ai':
    case 'google-vertex': return googleReasoning(model);
    case 'bedrock-converse-stream': return bedrockReasoning(model);
    case 'mistral-conversations': {
      const discrete = ['mistral-small-2603', 'mistral-small-latest', 'zai-glm-5-2'].includes(model.id) || model.id.startsWith('mistral-medium-');
      if (!discrete) return toggle(model);
      // Unlike OpenAI, unconfigured Mistral levels all map to high.
      const result = efforts(model, () => 'high');
      if (!result) return undefined;
      const distinct = new Set(Object.entries(result).filter(([key]) => key !== 'off').map(([, value]) => value));
      if (distinct.size !== 1) return result;
      const level = ['high', 'medium', 'low', 'minimal', 'xhigh', 'max'].find(key => Object.hasOwn(result, key));
      return reasoningFields({ ...off(model), [level]: result[level] });
    }
    default: return undefined;
  }
}

function listed(levels, { objects = false, none = false, mandatory = false, allowed = THINKING_LEVELS } = {}) {
  if (!Array.isArray(levels)) return undefined;
  const out = {};
  for (const item of levels) {
    const level = typeof item === 'string' ? item : objects && object(item) ? item.effort : undefined;
    if (level === 'none' && none && !mandatory) out.off = 'none';
    else if (THINKING_LEVELS.includes(level) && allowed.includes(level) && (level !== 'off' || !mandatory)) out[level] = level;
  }
  return reasoningFields(out);
}

/**
 * Parse ONE raw list row, never a whole response or a name-based inference.
 * Only documented capability fields are accepted. `api` is the actual wire
 * protocol, not the provider label. No generic reasoning=true or name guessing.
 * References:
 * https://platform.claude.com/docs/en/api/models/list.md
 * https://docs.x.ai/developers/rest-api-reference/inference/models.md
 * https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md
 */
export function listingReasoning(raw, api) {
  if (!object(raw)) return undefined;
  if (api === 'anthropic-messages') {
    const caps = raw.capabilities;
    if (!object(caps)) return undefined;
    const thinking = caps.thinking, effort = caps.effort;
    const types = object(thinking?.types) ? thinking.types : undefined;
    if (effort?.supported === true) {
      const out = {};
      for (const level of EFFORT) if (effort[level]?.supported === true) out[level] = level;
      if (types?.disabled?.supported === true) out.off = null;
      return reasoningFields(out);
    }
    // Effort=false says nothing about extended thinking's token budgets.
    // Only an explicit enabled capability establishes budget support.
    if (types?.enabled?.supported === true) {
      return reasoningFields({ ...(types.disabled?.supported === true ? { off: null } : {}), ...Object.fromEntries(BASE.map(level => [level, level])) });
    }
    if (thinking?.supported === false && effort?.supported === false) return false;
    return undefined;
  }
  if (api === 'google-generative-ai' || api === 'google-vertex') return raw.thinking === false ? false : undefined;
  if (!OPENAI.includes(api)) return undefined;
  if (api === 'openai-codex-responses') return listed(raw.supported_reasoning_levels, { objects: true, none: true });
  // Gateway metadata must not leak into Anthropic Messages, even for an
  // OpenRouter provider. An absent supported_efforts is not explicit null.
  if (own(raw.reasoning, 'supported_efforts')) {
    return listed(raw.reasoning.supported_efforts === null ? GATEWAY : raw.reasoning.supported_efforts, { none: true, mandatory: raw.reasoning.mandatory === true, allowed: GATEWAY });
  }
  return listed(raw.capabilities?.reasoning_effort, { none: true });
}
