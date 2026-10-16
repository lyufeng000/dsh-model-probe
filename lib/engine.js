import { ProbeManager, DEFAULT_REFS } from './state.js';
import { UserError, object, diffModels } from './model.js';
import { APIS, probeModels, safeBase } from './probes.js';
import { enrichModels } from './enrich.js';
import { codexStatus, resolveCodexGrant } from './codex.js';
import { CatalogCache, discoveryModel } from './catalog-cache.js';

export class ProbeEngine extends ProbeManager {
  constructor(ctx, credentialsModule, { catalog, transport, catalogCache } = {}) {
    super(ctx, credentialsModule); this.catalog = catalog; this.transport = transport; this.jobs = new Map(); this.closed = false;
    this.catalogCache = catalogCache ?? new CatalogCache(ctx.profileContext?.dir);
    this.refreshes = new Map(); this.refreshControllers = new Map();
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
      const api = config?.api ?? defaults.api;
      const job = this.jobs.get(row.route), isCodex = row.route === 'openai-codex' || api === 'openai-codex-responses';
      const codex = isCodex ? await codexStatus(this.ctx, this.credentialsModule, row.route) : undefined;
      const manualOnly = isCodex ? codex.manualOnly : false;
      return { ...row, api: APIS.includes(api) ? api : null, manualOnly, ...(codex ? { codex } : {}), probe: job ? { status: job.status, result: job.result, error: job.error } : { status: 'idle' } };
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
    const defaults = this.catalog?.defaults(route) ?? {}, api = payload.api || config.api || defaults.api || (route === 'openai-codex' ? 'openai-codex-responses' : undefined);
    if ((route === 'openai-codex' || config.api === 'openai-codex-responses') && api !== 'openai-codex-responses') throw new UserError('CODEX_MANUAL_ONLY', 'Codex 路由仅支持 openai-codex-responses 协议。');
    if (!APIS.includes(api)) throw new UserError('UNSUPPORTED_PROTOCOL', '无法确定受支持的列表协议，请手动选择协议与服务地址。');
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
      const auth = await this.keyFor(route, config, baseURL, api);
      const vendor = await probeModels({ api, baseURL, key: auth.key, accountId: auth.accountId, headers: config.headers, signal: controller.signal }, this.transport);
      let router = [], warning;
      if (payload.useOpenRouterEnrich) {
        try { router = (await probeModels({ api: 'openrouter', signal: controller.signal }, this.transport)).models; }
        catch (error) { if (controller.signal.aborted) throw error; warning = 'OpenRouter 补全失败；保留厂商与已验证目录信息。'; }
      }
      const models = enrichModels(vendor.models, { route, catalog: this.catalog, openrouter: router, useOpenRouterEnrich: payload.useOpenRouterEnrich, routeDefaults: true });
      await this.catalogCache.write({ route, api, baseURL }, models).catch(() => {});
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
        if (object(snapshot.current.providers?.[route])) config = snapshot.current.providers[route];
      } catch { /* ignore snapshot failure during early boot */ }
    }
    const defaults = (route && this.catalog?.defaults(route)) ?? {};
    const api = request.api || config.api || defaults.api || (route === 'openai-codex' ? 'openai-codex-responses' : undefined);
    const rawBase = request.baseURL || config.baseURL || defaults.baseURL || (api === 'openai-codex-responses' ? 'https://chatgpt.com/backend-api' : undefined);
    if (!APIS.includes(api) || !rawBase) return undefined;
    return { route, config, api, baseURL: safeBase(rawBase), apiKey: typeof request.apiKey === 'string' && request.apiKey.trim() ? request.apiKey.trim() : undefined, explicitEndpoint: Boolean(request.baseURL || request.api) };
  }
  canFallback(request, fallback) {
    return Boolean(fallback) && !request.apiKey && !request.baseURL && !request.api && (this.catalog?.list(request.provider)?.length ?? 0) > 0;
  }
  joinRefresh(plan) {
    const id = `${plan.route ?? ''}\n${plan.api}\n${plan.baseURL}`;
    const existing = this.refreshes.get(id);
    if (existing) return existing;
    const controller = new AbortController();
    const job = this.refreshCatalog(plan, controller.signal);
    this.refreshes.set(id, job);
    this.refreshControllers.set(id, controller);
    const finish = job.finally(() => {
      if (this.refreshes.get(id) === job) this.refreshes.delete(id);
      if (this.refreshControllers.get(id) === controller) this.refreshControllers.delete(id);
    });
    return finish;
  }
  async refreshCatalog(plan, signal) {
    if (this.closed) throw new UserError('UNAVAILABLE', '插件正在停止，请重试。');
    const auth = plan.apiKey ? { key: plan.apiKey } : await this.keyFor(plan.route, plan.config, plan.baseURL, plan.api);
    const vendor = await probeModels({ api: plan.api, baseURL: plan.baseURL, key: auth.key, accountId: auth.accountId, headers: plan.config.headers, signal }, this.transport);
    const models = enrichModels(vendor.models, { route: plan.route, catalog: this.catalog, routeDefaults: true }).map(discoveryModel).filter(Boolean);
    await this.catalogCache.write(plan, models).catch(() => {});
    return models;
  }
  async discoverForSettings(request = {}, signal, fallback) {
    if (this.closed) return fallback ? fallback(request, signal) : [];
    let plan;
    try { plan = this.discoveryPlan(request); }
    catch (error) {
      if (this.canFallback(request, fallback)) return fallback(request, signal);
      throw error;
    }
    if (!plan) {
      if (fallback) return fallback(request, signal);
      throw new UserError('UNSUPPORTED_PROTOCOL', '该路由不支持在线获取可用模型。');
    }
    // File first so the settings picker opens immediately; the live request updates the file for the next open.
    const cached = await this.catalogCache.read(plan);
    const refresh = this.joinRefresh(plan);
    void refresh.catch(() => {});
    if (cached?.length) return cached;
    try { return await refresh; }
    catch (error) {
      if (this.canFallback(request, fallback)) return fallback(request, signal);
      throw error;
    }
  }
  cancel({ route }) { this.routeSnapshot(route); const job = this.jobs.get(route); job?.controller?.abort(); return { cancelled: job?.status === 'probing' }; }
  dispose() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller?.abort();
    for (const controller of this.refreshControllers.values()) controller.abort();
    this.jobs.clear(); this.refreshes.clear(); this.refreshControllers.clear();
  }
}
