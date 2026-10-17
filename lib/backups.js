import { mkdir, open, readdir, readFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserError, object, FIELDS, validateDraft, validId } from './model.js';

const ID = /^\d{8}-\d{9}-[0-9a-f-]{36}$/;
// Backups written before DSH 0.2.1 carry no marker: they may predate the
// reasoningEfforts/Argon metadata in the current config, so restoring one must
// not silently drop capabilities or write an obsolete capacity. New files are
// labelled, and the reader keeps accepting unlabelled files for listing only.
export const BACKUP_COMPAT = 'dsh>=0.2.1-rc.2';
export function routeFields(config) {
  const result = {};
  if (Object.hasOwn(config, 'models')) {
    if (config.models === null) result.models = null;
    else if (Array.isArray(config.models)) {
      for (const model of config.models) if (!object(model) || Object.keys(model).some(key => !FIELDS.includes(key))) throw new UserError('UNSAFE_BACKUP', '现有模型包含本插件白名单之外的字段，无法无损备份；请使用官方模型页。');
      result.models = config.models.length ? validateDraft(config.models) : [];
    } else throw new UserError('UNSAFE_BACKUP', '现有模型字段不支持安全备份，请使用官方模型页。');
  }
  if (Object.hasOwn(config, 'modelOverrides')) {
    if (config.modelOverrides === null) result.modelOverrides = null;
    else {
      if (!object(config.modelOverrides)) throw new UserError('UNSAFE_BACKUP', '现有参数覆盖无法安全备份。');
      result.modelOverrides = Object.fromEntries(Object.entries(config.modelOverrides).map(([id, fields]) => {
        if (!validId(id) || !object(fields) || Object.keys(fields).some(key => key === 'id' || !FIELDS.includes(key))) throw new UserError('UNSAFE_BACKUP', '现有参数覆盖包含本插件白名单之外的字段，请使用官方模型页。');
        const { id: ignored, ...safe } = validateDraft([{ ...fields, id }])[0];
        return [id, safe];
      }));
    }
  }
  // Refuse normalization of existing fields: a backup must be a lossless round trip.
  if (JSON.stringify(result) !== JSON.stringify(Object.fromEntries(['models', 'modelOverrides'].filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]])))) {
    // Property order is immaterial, but names/modalities must not be silently normalized.
    const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    if (JSON.stringify(canonical(result)) !== JSON.stringify(canonical(Object.fromEntries(['models', 'modelOverrides'].filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]]))))) throw new UserError('UNSAFE_BACKUP', '现有模型字段需要规范化，无法原样备份；请先使用官方模型页整理。');
  }
  return result;
}
export class BackupStore {
  constructor(profileDir) { this.dir = join(profileDir, '.model-probe-backups'); }
  path(id) { if (!ID.test(id)) throw new UserError('INVALID_BACKUP', '备份标识无效。'); return join(this.dir, `.bak-model-probe-${id}.json`); }
  async save({ route, revision, fields }) {
    const createdAt = new Date().toISOString(), id = createdAt.replace(/[-:TZ.]/g, '').replace(/^(\d{8})(.*)$/, '$1-$2') + '-' + randomUUID();
    const body = JSON.stringify({ version: 1, id, createdAt, route, revision, compat: BACKUP_COMPAT, fields: routeFields(fields) }, null, 2) + '\n';
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new UserError('BACKUP_FAILED', '模型备份超过 4 MiB 安全上限；未提交配置写入。');
    let file, created = false;
    try { await mkdir(this.dir, { recursive: true }); file = await open(this.path(id), 'wx', 0o600); created = true; await file.writeFile(body, 'utf8'); await file.sync(); await file.close(); }
    catch { if (file) await file.close().catch(() => {}); if (created) await unlink(this.path(id)).catch(() => {}); throw new UserError('BACKUP_FAILED', '无法保存安全备份；未提交配置写入。'); }
    return { id, createdAt, route };
  }
  async read(id) {
    try {
      const path = this.path(id), stat = await lstat(path);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error();
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (data.version !== 1 || data.id !== id || !validId(data.route) || typeof data.createdAt !== 'string' || (data.compat !== undefined && typeof data.compat !== 'string') || !object(data.fields) || Object.keys(data.fields).some(key => !['models', 'modelOverrides'].includes(key))) throw Error();
      const compat = typeof data.compat === 'string' ? data.compat : undefined;
      return { ...data, fields: routeFields(data.fields), compat, legacy: compat === undefined };
    } catch { throw new UserError('INVALID_BACKUP', '备份不存在、已轮换或内容无效。'); }
  }
  async list() {
    let names; try { names = await readdir(this.dir); } catch (error) { if (error.code === 'ENOENT') return []; throw new UserError('BACKUP_UNAVAILABLE', '备份目录不可读。'); }
    const result = [];
    for (const name of names) {
      const id = name.replace(/^\.bak-model-probe-/, '').replace(/\.json$/, '');
      if (!ID.test(id) || name !== `.bak-model-probe-${id}.json`) continue;
      try { const { createdAt, route, legacy } = await this.read(id); result.push({ id, createdAt, route, legacy }); } catch { /* Invalid or foreign files are never removed. */ }
    }
    return result.sort((a, b) => b.id.localeCompare(a.id));
  }
  async prune() { for (const backup of (await this.list()).slice(5)) await unlink(this.path(backup.id)); }
}
