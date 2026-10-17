import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BackupStore, routeFields } from './backups.js';
import { UserError, object, modelFields, validateDraft } from './model.js';
import { revisionOf } from './state.js';
import { exactModelEdit } from './native-save.js';

function routeConfig(current, route) {
  if (typeof route !== 'string' || !object(current.providers) || !Object.hasOwn(current.providers, route) || !object(current.providers[route])) throw new UserError('INVALID_ROUTE', '路由不存在，请刷新页面。');
  return current.providers[route];
}
function checkRevision(actual, expected) {
  if (typeof expected !== 'string' || actual !== expected) throw new UserError('REVISION_CONFLICT', '配置已变化；请刷新页面并重新预览，未覆盖其他修改。');
}
function replaceFields(current, route, fields) {
  routeConfig(current, route); const next = structuredClone(current), target = next.providers[route];
  delete target.models; delete target.modelOverrides;
  Object.assign(target, structuredClone(fields)); return next;
}
export class ProfileEditor {
  constructor(ctx, engine, { backups = new BackupStore(ctx.profileContext.dir), now = Date.now } = {}) {
    this.ctx = ctx; this.engine = engine; this.backups = backups; this.now = now; this.previews = new Map(); this.busy = false; this.closed = false;
  }
  async listBackups() { return this.backups.list(); }
  async preview(payload) {
    if (this.closed) throw new UserError('DISPOSED', '插件正在关闭。');
    const { route, revision, action } = payload ?? {}, snapshot = this.engine.snapshot();
    checkRevision(snapshot.revision, revision);
    const config = routeConfig(snapshot.current, route), before = routeFields(config);
    let after, models;
    if (action === 'adopt') {
      models = validateDraft(payload.models); after = { models };
    } else if (action === 'restore') {
      const builtin = this.engine.catalog?.list(route) ?? [];
      if (!builtin.length) throw new UserError('NO_BUILTIN_CATALOG', '此路由没有可恢复的内置目录，请保留手动模型列表。');
      after = structuredClone(before); delete after.models;
      models = builtin.map(model => modelFields({ ...model, ...(after.modelOverrides?.[model.id] ?? {}), id: model.id, maxTokens: after.modelOverrides?.[model.id]?.maxTokens ?? model.maxTokens ?? model.defaultMaxTokens, input: after.modelOverrides?.[model.id]?.input ?? model.input ?? model.inputModalities }));
    } else if (action === 'rollback') {
      const backup = await this.backups.read(payload.backupId);
      if (backup.route !== route) throw new UserError('INVALID_BACKUP', '备份不属于当前路由。');
      // A pre-0.2.1 backup carries no compatibility marker. Refuse silently
      // restoring it: it may lack reasoningEfforts (Argon loses its thinking
      // levels) or carry an obsolete model capacity from the old catalog.
      if (backup.legacy) throw new UserError('LEGACY_BACKUP_UNSAFE', '该备份创建于 DSH 0.2.1 升级之前，缺少兼容标记；恢复可能静默丢失 reasoningEfforts 或写入过期容量。为安全起见已拒绝，请先新建备份后再恢复。');
      after = backup.fields;
      models = after.models?.length ? after.models : (this.engine.catalog?.list(route) ?? []).map(model => modelFields({ ...model, ...(after.modelOverrides?.[model.id] ?? {}), id: model.id }));
      if (!models.length) throw new UserError('NO_BUILTIN_CATALOG', '该备份没有显式模型，当前也没有可用内置目录。');
    } else throw new UserError('INVALID_ACTION', '不支持的配置操作。');
    // Metadata resolution only: it never proves catalog membership and never performs inference.
    const checks = action === 'adopt' ? models : [], unresolved = [];
    for (const model of checks) {
      if (this.closed) throw new UserError('DISPOSED', '插件正在关闭。');
      try { await this.ctx.llm.resolveModelInfo(route, model.id); }
      catch (error) {
        // A new vendor model is deliberately not in the current served list yet.
        // UNKNOWN_MODEL is expected here; the official ConfigEditor validates the proposed catalog on write.
        if (error.code === 'UNKNOWN_MODEL') unresolved.push(model.id);
        else throw new UserError('PREFLIGHT_FAILED', '模型元数据预检失败，请检查路由设置；未写入配置。');
      }
    }
    checkRevision(this.engine.snapshot().revision, revision);
    const served = await this.ctx.llm.listModels(route), oldIds = new Set(served.map(model => model.id)), newIds = new Set(models.map(model => model.id));
    const probed = new Map((this.engine.jobs.get(route)?.result?.models ?? []).map(model => [model.id, model]));
    const sources = action === 'adopt' ? models.map(model => ({ id: model.id, fields: Object.fromEntries(Object.keys(model).map(field => [field, isDeepStrictEqual(probed.get(model.id)?.[field], model[field]) ? probed.get(model.id)?.sources?.[field] ?? 'manual' : 'manual'])) })) : [];
    const token = randomUUID(), expiresAt = this.now() + 5 * 60 * 1000;
    for (const [key, value] of this.previews) if (value.expiresAt < this.now()) this.previews.delete(key);
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(token, { route, revision, action, before, after, expiresAt, expectedIds: [...newIds] });
    return { token, route, revision, action, expiresAt, before, after, unresolved, added: [...newIds].filter(id => !oldIds.has(id)), removed: [...oldIds].filter(id => !newIds.has(id)), sources, changed: !isDeepStrictEqual(before, after), clearsOverrides: action === 'adopt' && Object.hasOwn(before, 'modelOverrides') };
  }
  async commit(payload, action) {
    if (this.closed) throw new UserError('DISPOSED', '插件正在关闭。');
    if (this.busy) throw new UserError('WRITE_BUSY', '另一个配置写入正在进行，请稍后重试。');
    const preview = this.previews.get(payload?.token);
    if (!preview || preview.expiresAt <= this.now() || payload.confirm !== true || preview.action !== action || payload.route !== preview.route || payload.revision !== preview.revision) throw new UserError('PREVIEW_REQUIRED', '请重新生成差异预览并明确确认写入。');
    this.busy = true;
    try {
      const snapshot = this.engine.snapshot(); checkRevision(snapshot.revision, preview.revision);
      routeConfig(snapshot.current, preview.route);
      const backup = await this.backups.save({ route: preview.route, revision: preview.revision, fields: preview.before });
      this.previews.delete(payload.token);
      try {
        await this.ctx.configEditor.edit(snapshot.entry, exactModelEdit((current, inherited) => {
          // This callback runs inside the official lock AFTER disk reconciliation.
          if (this.closed) throw new UserError('DISPOSED', '插件正在关闭，未提交配置写入。');
          checkRevision(revisionOf(current, inherited), preview.revision);
          return replaceFields(current, preview.route, preview.after);
        }));
      } catch (error) {
        // Failed commits also create backups; rotate them without hiding the write error.
        const failure = error instanceof UserError ? error : new UserError('WRITE_FAILED', '官方编辑器未完成写入，请刷新核对配置；写前备份已保留。');
        try { await this.backups.prune(); } catch { failure.message += ' 旧备份清理失败，保留数量可能超过 5 份。'; }
        throw failure;
      }
      let hotReloaded = false, revision = null, warning;
      try {
        const ids = (await this.ctx.llm.listModels(preview.route)).map(model => model.id).sort();
        hotReloaded = isDeepStrictEqual(ids, [...preview.expectedIds].sort()); revision = this.engine.snapshot().revision;
      } catch { /* A successful edit must not be reported as a failed write because a post-read failed. */ }
      if (!hotReloaded) warning = '配置已保存，但暂未确认模型服务列表同步；请刷新并核对官方模型页。';
      try { await this.backups.prune(); } catch { warning = (warning ? warning + ' ' : '') + '旧备份清理失败；配置已保存。'; }
      return { applied: true, route: preview.route, revision, backup, hotReloaded, warning };
    } finally { this.busy = false; }
  }
  dispose() { this.closed = true; this.previews.clear(); }
}
