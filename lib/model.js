export const CHANNEL = '/api';
export const VERSION = 1;
export const FIELDS = ['id', 'name', 'contextWindow', 'maxTokens', 'input'];
export class UserError extends Error {
  constructor(code, message) { super(message); this.name = 'UserError'; this.code = code; }
}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(value);
export const positive = value => Number.isSafeInteger(value) && value > 0;
export function modelFields(value) {
  const out = { id: value.id };
  if (typeof value.name === 'string' && value.name.trim() && value.name.length <= 512) out.name = value.name.trim();
  for (const key of ['contextWindow', 'maxTokens']) if (positive(value[key])) out[key] = value[key];
  if (Array.isArray(value.input)) {
    const input = [...new Set(value.input.filter(x => x === 'text' || x === 'image'))];
    if (input.length) out.input = input;
  }
  return out;
}
/** A candidate has only safe model fields and per-field provenance; never retain raw responses. */
export function normalizeProbeBody(body) {
  let items;
  if (Array.isArray(body?.data)) items = body.data;
  else if (object(body?.models)) items = Object.entries(body.models).filter(([, x]) => object(x)).map(([id, x]) => ({ ...x, id }));
  else if (Array.isArray(body?.models)) items = body.models;
  else throw new UserError('DISCOVERY_PARSE_UNSUPPORTED', '厂商模型列表格式不受支持；配置未改动。');
  if (items.length > 10000) throw new UserError('TOO_MANY_MODELS', '厂商返回的模型数量超出上限。');
  const seen = new Set(), result = [];
  for (const raw of items) {
    if (!object(raw) || !validId(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const model = modelFields({ ...raw, name: raw.name ?? raw.display_name, contextWindow: raw.contextWindow ?? raw.context_length, maxTokens: raw.maxTokens ?? raw.max_output_tokens });
    result.push({ ...model, sources: Object.fromEntries(Object.keys(model).map(key => [key, 'vendor'])) });
  }
  return result;
}
export function validateDraft(models) {
  if (!Array.isArray(models) || !models.length || models.length > 10000) throw new UserError('INVALID_MODELS', '请至少选择一个模型（最多 10000 个）。');
  const ids = new Set();
  return models.map(value => {
    if (!object(value) || !validId(value.id) || ids.has(value.id)) throw new UserError('INVALID_MODEL_ID', '模型 ID 不能为空、重复或包含空白/控制字符。');
    ids.add(value.id);
    for (const key of ['contextWindow', 'maxTokens']) if (Object.hasOwn(value, key) && !positive(value[key])) throw new UserError('INVALID_PARAMETER', '上下文和输出上限必须为正整数，未知时请留空。');
    if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512)) throw new UserError('INVALID_PARAMETER', '模型名称无效。');
    if (value.input !== undefined && (!Array.isArray(value.input) || !value.input.length || value.input.some(x => x !== 'text' && x !== 'image'))) throw new UserError('INVALID_PARAMETER', '输入模态只支持 text / image。');
    return modelFields(value);
  });
}
export function diffModels(served, probed) {
  const known = new Set(served.map(x => x.id)), available = new Set(probed.map(x => x.id));
  return { declared: probed.filter(x => known.has(x.id)), outside: probed.filter(x => !known.has(x.id)), missing: served.filter(x => !available.has(x.id)) };
}
