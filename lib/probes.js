import { UserError, normalizeProbeBody, object } from './model.js';

export const MAX_BYTES = 4 * 1024 * 1024;
export const APIS = ['google-generative-ai', 'openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'openrouter'];
const DEFAULT_BASES = { 'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta', 'openai-completions': 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', 'openai-codex-responses': 'https://chatgpt.com/backend-api', 'anthropic-messages': 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1' };
export function safeBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new UserError('INVALID_ENDPOINT', '请输入有效的模型服务地址。'); }
  if (url.username || url.password || url.search || url.hash) throw new UserError('UNSAFE_ENDPOINT', '服务地址不能包含用户名、密码、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new UserError('UNSAFE_ENDPOINT', '只允许 HTTPS；明文 HTTP 仅允许本机回环地址。');
  return url.href.replace(/\/+$/, '');
}
export function requestSpec({ api, baseURL, key, accountId, headers: customHeaders }) {
  if (!APIS.includes(api)) throw new UserError('UNSUPPORTED_PROTOCOL', '该协议不支持模型列表探测；请手动填写，不会尝试推理或 OAuth 刷新。');
  const base = safeBase(baseURL ?? DEFAULT_BASES[api]);
  const headers = { accept: 'application/json' };
  if (object(customHeaders)) {
    for (const [k, v] of Object.entries(customHeaders)) {
      if (typeof v === 'string' && !/[\r\n]/.test(k) && !/[\r\n]/.test(v)) headers[k.toLowerCase()] = v;
    }
  }
  if (key !== undefined && (typeof key !== 'string' || !key || /[\r\n]/.test(key))) throw new UserError('INVALID_CREDENTIAL', '凭据不可用，请到官方「模型」页检查。');
  if (accountId !== undefined && (typeof accountId !== 'string' || !accountId || /[\r\n]/.test(accountId))) throw new UserError('INVALID_CREDENTIAL', '凭据不可用，请到官方「模型」页检查。');
  if (key) {
    if (api === 'google-generative-ai') headers['x-goog-api-key'] = key;
    else if (api === 'anthropic-messages') headers['x-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  if (api === 'openai-codex-responses') {
    headers.originator = 'pi';
    if (accountId) headers['chatgpt-account-id'] = accountId;
    const codexBase = base.endsWith('/codex') ? base : `${base.replace(/\/v1$/, '')}/codex`;
    return { url: `${codexBase}/models?client_version=99.0.0`, headers };
  }
  return { url: api === 'anthropic-messages' ? `${base.replace(/\/v1$/, '')}/v1/models?limit=1000` : `${base}/models${api === 'google-generative-ai' ? '?pageSize=1000' : ''}`, headers };
}
function cancelled(signal) { if (signal.aborted) throw signal.reason; }
function containsSecret(value, key) {
  if (typeof value === 'string') return value.includes(key);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, key));
  return object(value) && Object.values(value).some(item => containsSecret(item, key));
}
async function boundedJSON(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new UserError('RESPONSE_TOO_LARGE', '厂商响应超过 4 MiB，已拒绝读取。');
  }
  if (!response.body) throw new UserError('INVALID_JSON', '厂商未返回有效 JSON。');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      cancelled(signal);
      const { done, value } = await reader.read();
      cancelled(signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new UserError('RESPONSE_TOO_LARGE', '厂商响应超过 4 MiB，已拒绝读取。');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
    catch { throw new UserError('INVALID_JSON', '厂商未返回有效 JSON。'); }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function parseListing(body, api) {
  if (api === 'google-generative-ai') {
    if (!Array.isArray(body?.models)) throw new UserError('DISCOVERY_PARSE_UNSUPPORTED', 'Google 模型列表格式不受支持。');
    body = { data: body.models.filter(x => object(x) && Array.isArray(x.supportedGenerationMethods) && x.supportedGenerationMethods.includes('generateContent')).map(x => ({ id: typeof x.name === 'string' ? x.name.replace(/^models\//, '') : undefined, name: x.displayName, contextWindow: x.inputTokenLimit, maxTokens: x.outputTokenLimit })) };
  } else if (api === 'openai-codex-responses') {
    if (!Array.isArray(body?.models)) throw new UserError('DISCOVERY_PARSE_UNSUPPORTED', 'Codex 模型列表格式不受支持。');
    body = { data: body.models.filter(x => object(x) && x.visibility !== 'hide' && x.supported_in_api !== false).map(x => ({ id: x.slug ?? x.id, name: x.display_name ?? x.name, contextWindow: x.context_window ?? x.contextWindow, maxTokens: x.max_output_tokens ?? x.maxTokens, input: x.input_modalities ?? x.input })) };
  } else if (api === 'openrouter' && Array.isArray(body?.data)) {
    body = { data: body.data.map(x => object(x) ? { ...x, input: x.architecture?.input_modalities, maxTokens: x.top_provider?.max_completion_tokens } : x) };
  }
  return normalizeProbeBody(body);
}
/** Never put response text, URLs or headers into errors. No redirects, inference or auth refresh. */
export async function probeModels(options, { fetch: fetcher = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const spec = requestSpec(options), controller = new AbortController();
  const cancel = () => controller.abort(new UserError('CANCELLED', '探测已取消。'));
  const timer = setTimeout(() => controller.abort(new UserError('TIMEOUT', '探测超时（默认 20 秒），请检查服务后重试。')), timeoutMs);
  const external = options.signal;
  external?.addEventListener('abort', cancel, { once: true });
  if (external?.aborted) cancel();
  let stop;
  const aborted = new Promise((_, reject) => {
    stop = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', stop, { once: true });
    if (controller.signal.aborted) stop();
  });
  try {
    return await Promise.race([aborted, (async () => {
      cancelled(controller.signal);
      const response = await fetcher(spec.url, { method: 'GET', headers: spec.headers, redirect: 'manual', signal: controller.signal });
      cancelled(controller.signal);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new UserError('REDIRECT_REJECTED', '厂商返回重定向；为避免凭据外泄，未跟随跳转。请检查服务地址。');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new UserError(response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'HTTP_ERROR', response.status === 401 || response.status === 403 ? '厂商拒绝认证，请在官方「模型」页检查凭据与权限。' : `厂商返回 HTTP ${response.status}；配置未改动。`);
      }
      const body = await boundedJSON(response, controller.signal), models = parseListing(body, options.api);
      if (options.key && containsSecret(models, options.key)) throw new UserError('SENSITIVE_RESPONSE', '厂商响应包含敏感内容，已拒绝展示。');
      if (options.accountId && containsSecret(models, options.accountId)) throw new UserError('SENSITIVE_RESPONSE', '厂商响应包含敏感内容，已拒绝展示。');
      return { models, fetchedAt: new Date().toISOString(), incomplete: body?.has_more === true || Boolean(body?.nextPageToken) };
    })()]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof UserError) throw error;
    throw new UserError('NETWORK_ERROR', '无法连接模型服务；请检查地址、网络或代理。');
  } finally { clearTimeout(timer); external?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', stop); }
}
