import { UserError, object } from './model.js';

const login = '请到 设置 → 模型 → OpenAI Codex 重新登录。本插件仅读取授权，不会刷新或改写登录记录。';
const messages = Object.freeze({
  CODEX_NOT_SIGNED_IN: '未找到 Codex 登录记录。' + login,
  CODEX_RECORD_UNSUPPORTED: '无法识别 Codex 登录记录结构。' + login,
  CODEX_EXPIRED: 'Codex 登录记录已过期。' + login,
  CODEX_RECORD_UNAVAILABLE: '暂时无法读取 Codex 登录状态。请检查官方「模型」页；本插件不会刷新或改写登录记录。',
  CODEX_READY: 'Codex 登录记录在有效期内，可直接询问厂商模型列表；本插件不会刷新或改写登录记录。',
});

function inspectRecord(record, now = Date.now()) {
  const payload = record?.payload;
  if (!record) return { code: 'CODEX_NOT_SIGNED_IN' };
  if (record.kind !== 'grant' || !object(payload) || payload.type !== 'oauth'
    || !['access', 'refresh', 'accountId'].every(key => typeof payload[key] === 'string' && payload[key].length > 0)
    || !Number.isFinite(payload.expires) || payload.expires <= 0) return { code: 'CODEX_RECORD_UNSUPPORTED' };
  if (payload.expires <= now) return { code: 'CODEX_EXPIRED' };
  return { code: 'CODEX_READY', access: payload.access, accountId: payload.accountId };
}

// Only this fixed status projection crosses RPC: never the record, errors, token, accountId, expiry or raw response.
export async function codexStatus(ctx, credentialsModule, route = 'openai-codex', now = Date.now()) {
  let code;
  try {
    const record = await ctx.credentials.readRecord(credentialsModule.credentialKey('llm-pi-ai', route));
    code = inspectRecord(record, now).code;
  } catch { code = 'CODEX_RECORD_UNAVAILABLE'; }
  return { code, message: messages[code], manualOnly: code !== 'CODEX_READY' };
}

export async function resolveCodexGrant(ctx, credentialsModule, route = 'openai-codex', now = Date.now()) {
  let inspected;
  try {
    const record = await ctx.credentials.readRecord(credentialsModule.credentialKey('llm-pi-ai', route));
    inspected = inspectRecord(record, now);
  } catch {
    throw new UserError('CODEX_RECORD_UNAVAILABLE', messages.CODEX_RECORD_UNAVAILABLE);
  }
  if (inspected.code !== 'CODEX_READY') throw new UserError(inspected.code, messages[inspected.code]);
  return { key: inspected.access, accountId: inspected.accountId };
}
