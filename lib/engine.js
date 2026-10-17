import { createHash } from 'node:crypto';
import { ProbeManager, DEFAULT_REFS } from './state.js';

// Only an opaque digest, never the credential or header value, enters a cache key.
function authenticationScope(auth, headers) {
  return createHash('sha256').update(JSON.stringify([auth.key ?? null, auth.accountId ?? null,
    Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
}
function checkCancelled(signal) {
  if (signal?.aborted) throw new UserError('CANCELLED', '探测已取消。');
}
async function abortable(promise, signal) {
  checkCancelled(signal);
  let rejectAbort;
  const onAbort = () => rejectAbort(new UserError('CANCELLED', '探测已取消。'));
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
import { UserError, object, diffModels } from './model.js';
import { APIS, AZURE_APIS, AZURE_ROUTES, discoveryProtocolError, probeModels, safeBase } from './probes.js';
import { enrichModels } from './enrich.js';
import { codexStatus, resolveCodexGrant } from './codex.js';
import { CatalogCache, discoveryModel } from './catalog-cache.js';

export class ProbeEngine extends ProbeManager {
  constructor(ctx, credentialsModule, { catalog, transport, catalogCache } = {}) {
    super(ctx, credentialsModule); this.catalog = catalog; this.transport = transport; this.jobs = new Map(); this.closed = false;
    this.catalogCache = catalogCache ?? new CatalogCache(ctx.profileContext?.dir, { catalogGeneratedAt: catalog?.generatedAt });
    this.refreshes = new Map(); this.refreshControllers = new Map();
    this.lifecycle = new AbortController();
  }
  routeSnapshot(route) {
    const snapshot = this.snapshot();
    if (typeof route !== 'string' || !Object.hasOwn(snapshot.current.providers ?? {}, route) || !object(snapshot.current.providers[route])) throw new UserError('UNKNOWN_ROUTE', '请选择已存在的模型路由。');
    return { ...snapshot, config: snapshot.current.providers[route] };
  }
  async state() {
    const snapshot = this.snapshot(), state = await super.state(snapshot);
    return { ...state, routes: await Promise.all(state.routes.map(async row => {
      const defaults = this.catalog?.defaults(row.route) ?? {}, config = snapshot.current.providers[row.route];
      const api = config?.api ?? defaults.api ?? (AZURE_ROUTES.includes(row.route) ? 'azure-openai-responses' : undefined);
      const job = this.jobs.get(row.route), isCodex = row.route === 'openai-codex' || api === 'openai-codex-responses';
      const codex = isCodex ? await codexStatus(this.ctx, this.credentialsModule, row.route) : undefined;
      const manualOnly = isCodex ? codex.manualOnly : false;
      return { ...row, api: APIS.includes(api) || AZURE_APIS.includes(api) ? api : null, manualOnly, ...(codex ? { codex } : {}), probe: job ? { status: job.status, result: job.result, error: job.error } : { status: 'idle' } };
    })) };
  }
  async keyFor(route, config = {}, baseURL, api) {
    if (api === 'openai-codex-responses') {
      return await resolveCodexGrant(this.ctx, this.credentialsModule, route);
    }
    const ref = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : DEFAULT_REFS[route];
    if (config.apiKeyEnv === undefined && typeof route === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) {
      const record = await this.ctx.credentials.readRecord(this.credentialsModule.credentialKey('llm-pi-ai', route));
      if (record) {
        if (record.kind !== 'api-key') throw new UserError('OAUTH_MANUAL_ONLY', '该路由使用登录授权；本版本不猜测 OAuth 列表接口，请手动填写。');
        const value = record.key ?? (ref && record.env?.[ref]);
        if (typeof value === 'string' && value) return { key: value };
        throw new UserError('MISSING_CREDENTIAL', '已存认证记录不包含可用 API Key，请在官方「模型」页检查。');
      }
    }
    const value = ref ? (await this.ctx.credentials.resolve(this.credentialsModule.credentialRef(ref)))?.value : undefined;
    if (typeof value === 'string' && value) return { key: value };
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname);
    if (!config.apiKeyEnv && (loopback || api === 'openrouter')) return { key: undefined };
    throw new UserError('MISSING_CREDENTIAL', '未找到可用凭据，请到官方「模型」页配置；本页面不接收密钥。');
  }
  async probe(payload, signal) {
    if (this.closed) throw new UserError('UNAVAILABLE', '插件正在停止，请重试。');
    const { route } = payload, snapshot = this.routeSnapshot(route), { config, revision } = snapshot;
    if (this.jobs.get(route)?.status === 'probing') throw new UserError('PROBE_BUSY', '此路由正在探测，请等待或先取消。');
    if ([...this.jobs.values()].filter(job => job.status === 'probing').length >= 4) throw new UserError('PROBE_LIMIT', '同时最多探测 4 条路由。');
    const defaults = this.catalog?.defaults(route) ?? {}, api = payload.api || config.api || defaults.api || (route === 'openai-codex' ? 'openai-codex-responses' : AZURE_ROUTES.includes(route) ? 'azure-openai-responses' : undefined);
    if ((route === 'openai-codex' || config.api === 'openai-codex-responses') && api !== 'openai-codex-responses') throw new UserError('CODEX_MANUAL_ONLY', 'Codex 路由仅支持 openai-codex-responses 协议。');
    if (!APIS.includes(api)) throw discoveryProtocolError(api);
    const configuredBase = config.baseURL ?? defaults.baseURL ?? (api === 'openai-codex-responses' ? 'https://chatgpt.com/backend-api' : undefined);
    if (!configuredBase && !payload.baseURL) throw new UserError('MISSING_ENDPOINT', '此自定义路由没有服务地址，请明确指定。');
    const baseURL = safeBase(payload.baseURL || configuredBase);
    if (payload.baseURL && (!configuredBase || baseURL !== safeBase(configuredBase)) && payload.confirmEndpoint !== true) throw new UserError('ENDPOINT_CONFIRM_REQUIRED', '更改服务地址会向新地址发送当前凭据，请先明确确认。');
    if (payload.useOpenRouterEnrich !== undefined && typeof payload.useOpenRouterEnrich !== 'boolean') throw new UserError('INVALID_REQUEST', 'OpenRouter 补全开关必须为布尔值。');
    const controller = new AbortController(), job = { status: 'probing', controller };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.jobs.set(route, job);
    try {
      checkCancelled(controller.signal);
      const auth = await abortable(this.keyFor(route, config, baseURL, api), controller.signal);
      const vendor = await probeModels({ api, baseURL, key: auth.key, accountId: auth.accountId, headers: config.headers, signal: controller.signal }, this.transport);
      let router = [], warning;
      if (payload.useOpenRouterEnrich) {
        try { router = (await probeModels({ api: 'openrouter', signal: controller.signal }, this.transport)).models; }
        catch (error) { if (controller.signal.aborted) throw error; warning = 'OpenRouter 补全失败；保留厂商与已验证目录信息。'; }
      }
      const models = enrichModels(vendor.models, { route, catalog: this.catalog, api: config.api, discoveryApi: api, inheritReasoning: !payload.baseURL || Boolean(configuredBase && baseURL === safeBase(configuredBase)), openrouter: router, useOpenRouterEnrich: payload.useOpenRouterEnrich, routeDefaults: true });
      checkCancelled(controller.signal);
      await this.catalogCache.write({ route, api, baseURL, authScope: authenticationScope(auth, config.headers) }, models).catch(() => {});
      const served = (await this.ctx.llm.listModels(route)).map(model => ({ id: model.id, name: model.name }));
      const diff = diffModels(served, models);
      const result = { route, revision, models, fetchedAt: vendor.fetchedAt, incomplete: vendor.incomplete, warning, diff: { declared: diff.declared.map(x => x.id), outside: diff.outside.map(x => x.id), missing: diff.missing.map(x => x.id) }, catalogGeneratedAt: this.catalog?.generatedAt };
      if (controller.signal.aborted) throw new UserError('CANCELLED', '探测已取消。');
      job.status = 'done'; job.result = result; return result;
    } catch (error) {
      const safe = error instanceof UserError ? error : new UserError('PROBE_FAILED', '探测失败，请检查路由与凭据；配置未改动。');
      job.status = 'failed'; job.error = { code: safe.code, message: safe.message }; throw safe;
    } finally { signal?.removeEventListener('abort', abort); delete job.controller; }
  }
  discoveryPlan(request = {}) {
    const route = typeof request.provider === 'string' && request.provider.trim() ? request.provider.trim() : undefined;
    let config = {};
    if (route) {
      try {
        const snapshot = this.snapshot();
        if (Object.hasOwn(snapshot.current.providers ?? {}, route) && object(snapshot.current.providers[route])) config = snapshot.current.providers[route];
      } catch { /* ignore snapshot failure during early boot */ }
    }
    const defaults = (route && this.catalog?.defaults(route)) ?? {};
    const configuredApi = config.api || defaults.api || (route === 'openai-codex' ? 'openai-codex-responses' : route && AZURE_ROUTES.includes(route) ? 'azure-openai-responses' : undefined);
    const configuredBase = config.baseURL || defaults.baseURL || (configuredApi === 'openai-codex-responses' ? 'https://chatgpt.com/backend-api' : undefined);
    const api = request.api || configuredApi, rawBase = request.baseURL || configuredBase;
    // Refuse Azure before endpoint/credential work so a migrated route gets a precise,
    // actionable message instead of a generic unsupported-protocol or missing-key error.
    if (AZURE_APIS.includes(api)) throw discoveryProtocolError(api);
    if (!APIS.includes(api) || !rawBase) return undefined;
    const baseURL = safeBase(rawBase);
    const explicitKey = typeof request.apiKey === 'string';
    if (request.apiKey !== undefined && !explicitKey) throw new UserError('INVALID_CREDENTIAL', '一次性 API Key 必须为字符串。');
    const changedEndpoint = api !== configuredApi || !configuredBase || baseURL !== safeBase(configuredBase);
    if (changedEndpoint && !explicitKey) throw new UserError('ENDPOINT_CONFIRM_REQUIRED', '草稿修改了服务地址或协议；请提供一次性 API Key，或在模型探测页明确确认后探测。');
    // A draft key (even an explicitly empty key) must never inherit saved headers or OAuth.
    return { route, config: explicitKey ? {} : config, api, baseURL, explicitKey, changedEndpoint,
      apiKey: explicitKey ? request.apiKey.trim() || undefined : undefined };
  }
  localModels(route, config = {}) {
    const defaults = this.catalog?.defaults(route) ?? {};
    const builtinEndpoint = !config.baseURL || Boolean(defaults.baseURL && config.baseURL.replace(/\/$/, '') === defaults.baseURL.replace(/\/$/, ''));
    const rows = new Map((this.catalog?.list(route) ?? []).map(model => {
      const { reasoningEfforts, ...raw } = model;
      return [model.id, raw];
    }));
    for (const [id, override] of Object.entries(config.modelOverrides ?? {})) {
      if (rows.has(id)) rows.set(id, { ...rows.get(id), ...override, id });
    }
    for (const model of config.models ?? []) rows.set(model.id, { ...rows.get(model.id), ...model });
    return enrichModels([...rows.values()], { route, catalog: this.catalog, api: config.api, inheritReasoning: builtinEndpoint });
  }
  joinRefresh(plan, signal) {
    checkCancelled(signal);
    // Signal-bound requests are independent: cancelling one caller cannot cancel another.
    const id = signal || plan.explicitKey ? Symbol('discovery') : JSON.stringify([plan.route, plan.api, plan.baseURL, plan.authScope]);
    const existing = this.refreshes.get(id);
    if (existing) return existing;
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const job = this.refreshCatalog(plan, controller.signal).finally(() => {
      signal?.removeEventListener('abort', abort);
      if (this.refreshes.get(id) === job) this.refreshes.delete(id);
      if (this.refreshControllers.get(id) === controller) this.refreshControllers.delete(id);
    });
    this.refreshes.set(id, job);
    this.refreshControllers.set(id, controller);
    return job;
  }
  async refreshCatalog(plan, signal) {
    if (this.closed) throw new UserError('UNAVAILABLE', '插件正在停止，请重试。');
    checkCancelled(signal);
    const auth = plan.auth;
    const vendor = await probeModels({ api: plan.api, baseURL: plan.baseURL, key: auth.key, accountId: auth.accountId, headers: plan.config.headers, signal }, this.transport);
    const models = enrichModels(vendor.models, { route: plan.route, catalog: this.catalog, api: plan.changedEndpoint ? plan.api : plan.config.api, discoveryApi: plan.api, inheritReasoning: !plan.changedEndpoint, routeDefaults: !plan.changedEndpoint }).map(discoveryModel).filter(Boolean);
    checkCancelled(signal);
    if (!plan.explicitKey) await this.catalogCache.write(plan, models).catch(() => {});
    return models;
  }
  /** Opening the native picker is local-only: no credentials, cache I/O or network. */
  async discoverForSettings(request = {}, signal) {
    if (this.closed) throw new UserError('UNAVAILABLE', '插件正在停止，请重试。');
    checkCancelled(signal);
    const route = typeof request.provider === 'string' ? request.provider.trim() : undefined;
    let config = {};
    try {
      const providers = this.snapshot().current.providers ?? {};
      if (Object.hasOwn(providers, route) && object(providers[route])) config = providers[route];
    } catch { /* early boot */ }
    const defaults = this.catalog?.defaults(route) ?? {};
    const sameEndpoint = !request.baseURL || request.baseURL.replace(/\/$/, '') === (config.baseURL ?? defaults.baseURL ?? '').replace(/\/$/, '');
    const sameApi = !request.api || request.api === (config.api ?? defaults.api);
    // Draft credentials/endpoints must not expose the previous account's local list.
    if (request.apiKey !== undefined || !sameEndpoint || !sameApi) return [];
    return this.localModels(route, config).map(discoveryModel).filter(Boolean);
  }
  async refreshForSettings(request = {}, signal) {
    if (this.closed) throw new UserError('UNAVAILABLE', '插件正在停止，请重试。');
    signal = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    checkCancelled(signal);
    const plan = this.discoveryPlan(request);
    if (!plan) throw new UserError('UNSUPPORTED_PROTOCOL', '该路由不支持在线刷新模型；已保存的模型列表仍可使用。');
    // Scope saved catalogs to the actual authentication, not just the provider's URL.
    try {
      plan.auth = plan.explicitKey ? { key: plan.apiKey } : await abortable(this.keyFor(plan.route, plan.config, plan.baseURL, plan.api), signal);
    } catch (error) {
      checkCancelled(signal);
      // A configured live route must surface login/credential failure, not
      // silently turn a refresh into the old built-in catalog.
      throw error;
    }
    checkCancelled(signal);
    if (this.closed) throw new UserError('UNAVAILABLE', '插件正在停止，请重试。');
    plan.authScope = authenticationScope(plan.auth, plan.config.headers);
    // Refresh is live-only: cached/static lists must not disguise a failed
    // request as success. Metadata caches remain scoped and are still updated.
    return await this.joinRefresh(plan, signal);
  }
  /** Metadata for native saves, never a vendor request or an implicit adoption.
   * Re-resolve authentication so another account's cached capabilities cannot
   * leak into the saved profile. The writer rechecks route identity under lock.
   */
  async savedCatalogs() {
    const snapshot = this.snapshot(), rows = [];
    for (const [route, config] of Object.entries(snapshot.current.providers ?? {})) {
      if (this.closed) break;
      // Verified builtins require no login or successful online discovery. They
      // cover static native adoption even when the account/network is unavailable.
      const models = new Map(this.localModels(route, config).map(model => [model.id, model]));
      try {
        const plan = this.discoveryPlan({ provider: route });
        if (plan) {
          const auth = await abortable(this.keyFor(route, plan.config, plan.baseURL, plan.api), this.lifecycle.signal);
          plan.authScope = authenticationScope(auth, plan.config.headers);
          for (const model of await this.catalogCache.read(plan) ?? []) models.set(model.id, { ...models.get(model.id), ...model });
        }
      } catch { /* Do not reuse another credential scope's cached metadata. */ }
      if (models.size) rows.push({ route, config: structuredClone(config), models: [...models.values()] });
    }
    return rows;
  }
  cancel({ route }) { this.routeSnapshot(route); const job = this.jobs.get(route); job?.controller?.abort(); return { cancelled: job?.status === 'probing' }; }
  dispose() {
    this.closed = true;
    this.lifecycle.abort();
    for (const job of this.jobs.values()) job.controller?.abort();
    for (const controller of this.refreshControllers.values()) controller.abort();
    this.jobs.clear(); this.refreshes.clear(); this.refreshControllers.clear();
  }
}
