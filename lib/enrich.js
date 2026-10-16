import { FIELDS, modelFields } from './model.js';

/** Catalog lookup must prove exact membership, never use resolveModelInfo's unknown-id fallback. */
export function createCatalog(registry) {
  const providers = new Map(registry.builtinProviders().map(provider => [provider.id, provider]));
  const models = new Map(registry.getBuiltinProviders().map(route => [route, new Map(registry.getBuiltinModels(route).map(model => [model.id, model]))]));
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
export function enrichModels(candidates, { route, catalog, openrouter = [], useOpenRouterEnrich = false, manual = [], routeDefaults = false } = {}) {
  const routerMap = new Map(openrouter.map(model => [model.id, model]));
  const manualMap = new Map(manual.map(model => [model.id, model]));
  const fallback = routeDefaults && catalog?.defaults ? catalog.defaults(route) : undefined;
  return candidates.map(candidate => {
    const result = modelFields(candidate), sources = Object.fromEntries(Object.keys(result).map(field => [field, 'vendor']));
    const builtin = catalog?.lookup(route, candidate.id);
    const tiers = [
      ['catalog', builtin && { ...builtin, maxTokens: builtin.maxTokens ?? builtin.defaultMaxTokens, input: builtin.input ?? builtin.inputModalities }],
      ['openrouter', useOpenRouterEnrich ? routerMap.get(candidate.id) : undefined],
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
