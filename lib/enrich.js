import { FIELDS, modelFields } from './model.js';
import { catalogReasoning } from './reasoning.js';
import { argonReasoning } from './google-argon.js';

/** Catalog lookup must prove exact membership, never use resolveModelInfo's unknown-id fallback. */
export function createCatalog(registry, { googleArgon = false } = {}) {
  const providers = new Map(registry.builtinProviders().map(provider => [provider.id, provider]));
  const models = new Map(registry.getBuiltinProviders().map(route => [route, new Map(registry.getBuiltinModels(route).map(model => [model.id, model]))]));
  // Verified model metadata, enabled only alongside the matching wire adapter.
  // Do not replace newer upstream data when the runtime adds it itself.
  if (googleArgon && models.has('google') && !models.get('google').has('gemini-4-argon')) {
    const argon = { id: 'gemini-4-argon', name: 'Gemini 4 Argon', provider: 'google', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', reasoning: true, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'] };
    models.get('google').set(argon.id, { ...argon, reasoningEfforts: argonReasoning(argon) });
  }
  return {
    generatedAt: registry.getBuiltinModelDataGeneratedAt(),
    lookup: (route, id) => models.get(route)?.get(id),
    list: route => [...(models.get(route)?.values() ?? [])],
    defaults(route) {
      const provider = providers.get(route), list = [...(models.get(route)?.values() ?? [])];
      const apis = [...new Set(list.map(model => model.api).filter(Boolean))];
      const contextWindows = [...new Set(list.map(model => model.contextWindow).filter(x => Number.isSafeInteger(x) && x > 0))];
      const maxTokensList = [...new Set(list.map(model => model.maxTokens ?? model.defaultMaxTokens).filter(x => Number.isSafeInteger(x) && x > 0))];
      // Multiple APIs cannot be safely inferred for a custom override: require manual selection.
      return {
        baseURL: provider?.baseUrl ?? (list.length ? list[0].baseUrl : undefined),
        api: route === 'openrouter' ? 'openrouter' : apis.length === 1 ? apis[0] : undefined,
        contextWindow: contextWindows.length === 1 ? contextWindows[0] : undefined,
        maxTokens: maxTokensList.length === 1 ? maxTokensList[0] : undefined
      };
    }
  };
}
export function enrichModels(candidates, { route, catalog, api, discoveryApi, inheritReasoning = true, openrouter = [], useOpenRouterEnrich = false, manual = [], routeDefaults = false } = {}) {
  const routerMap = new Map(openrouter.map(model => [model.id, model]));
  const manualMap = new Map(manual.map(model => [model.id, model]));
  const fallback = routeDefaults && catalog?.defaults ? catalog.defaults(route) : undefined;
  return candidates.map(candidate => {
    const builtin = catalog?.lookup(route, candidate.id);
    const effectiveBuiltin = builtin && { ...builtin, ...(candidate.compat ? { compat: { ...builtin.compat, ...candidate.compat } } : {}) };
    const result = modelFields(candidate);
    // OpenRouter listing efforts describe its OpenAI gateway, not the native
    // Anthropic/Google protocol selected by a known runtime model.
    if (discoveryApi === 'openrouter' && (api ?? builtin?.api) && !['openrouter', 'openai-completions', 'openai-responses'].includes(api ?? builtin.api)) delete result.reasoningEfforts;
    // An effort allowlist cannot enable Anthropic adaptive serialization. When
    // the runtime lacks matching adaptive compat, use its verified builtin
    // budget semantics instead (or leave an unknown model unknown).
    if (discoveryApi === 'anthropic-messages' && result.reasoningEfforts && !effectiveBuiltin?.compat?.forceAdaptiveThinking) delete result.reasoningEfforts;
    const sources = Object.fromEntries(Object.keys(result).map(field => [field, 'vendor']));
    const tiers = [
      ['catalog', builtin && { ...builtin, reasoningEfforts: inheritReasoning && (!api || !builtin.api || api === builtin.api) ? (builtin.reasoningEfforts ?? catalogReasoning(effectiveBuiltin, { api })) : undefined, maxTokens: builtin.maxTokens ?? builtin.defaultMaxTokens, input: builtin.input ?? builtin.inputModalities }],
      ['openrouter', useOpenRouterEnrich && routerMap.has(candidate.id) ? { ...routerMap.get(candidate.id), reasoningEfforts: undefined } : undefined],
      ['manual', manualMap.get(candidate.id)],
      ['catalog', fallback && { contextWindow: fallback.contextWindow, maxTokens: fallback.maxTokens }]
    ];
    for (const [source, raw] of tiers) {
      if (!raw) continue;
      const fields = modelFields({ ...raw, id: candidate.id });
      for (const field of FIELDS) if (field !== 'id' && result[field] === undefined && fields[field] !== undefined) { result[field] = fields[field]; sources[field] = source; }
    }
    return { ...result, source: sources.contextWindow ?? sources.name ?? 'vendor', sources, inCatalog: Boolean(builtin) };
  });
}
