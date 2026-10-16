import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProfileEditor } from '../lib/profile.js';
import { BackupStore, routeFields } from '../lib/backups.js';
import { revisionOf } from '../lib/state.js';

function fixture(options = {}) {
  const current = { providers: { google: { apiKeyEnv: 'GOOGLE_API_KEY', models: [{ id: 'old', contextWindow: 100 }] }, other: { baseURL: 'https://example.test', models: [{ id: 'untouched' }] } }, untouched: { flag: true } };
  const entry = {}, inherited = {}, saved = [], calls = [];
  const state = { current, inherited, entry, edits: 0 };
  const builtin = [{ id: 'builtin', name: 'Builtin', contextWindow: 200, maxTokens: 100 }];
  const ctx = { profileContext: { dir: 'unused' }, llm: { async resolveModelInfo(route, id) { calls.push({ route, id }); if (options.preflightFail) throw Error('sensitive'); return { id }; }, async listModels(route) { return state.current.providers[route].models ?? builtin; } }, configEditor: { async edit(actual, change) { assert.equal(actual, entry); state.edits++; if (state.beforeEdit) state.beforeEdit(); const next = change(state.current, state.inherited); if (options.writeFail) throw Error('sensitive disk detail'); state.current = next; } } };
  const engine = { snapshot: () => ({ ...state, revision: revisionOf(state.current, state.inherited) }), jobs: new Map(), catalog: { list: () => builtin } };
  const backups = { async save(value) { if (options.backupFail) throw Error('backup failure'); saved.push(structuredClone(value)); return { id: `backup-${saved.length}`, route: value.route }; }, async read(id) { return saved[Number(id.split('-')[1]) - 1]; }, async list() { return []; }, async prune() {} };
  const editor = new ProfileEditor(ctx, engine, { backups, now: options.now ?? (() => 0) });
  const preview = (action = 'adopt', extra = {}) => editor.preview({ action, route: 'google', revision: engine.snapshot().revision, models: [{ id: 'new', contextWindow: 500, apiKey: 'DO-NOT-PERSIST' }], ...extra });
  const commit = p => editor.commit({ token: p.token, route: p.route, revision: p.revision, confirm: true }, p.action);
  return { state, entry, ctx, engine, editor, preview, commit, saved, calls, original: structuredClone(current) };
}

test('preview is read-only; commit changes only target models with whitelist and real entry', async () => {
  const f = fixture(), p = await f.preview(); assert.equal(f.state.edits, 0); assert.equal(f.saved.length, 0);
  assert.deepEqual(p.added, ['new']); assert.deepEqual(p.removed, ['old']); assert.deepEqual(f.calls, [{ route: 'google', id: 'new' }]);
  assert.equal(p.sources[0].fields.contextWindow, 'manual');
  const out = await f.commit(p); assert.equal(out.hotReloaded, true); assert.equal(out.applied, true);
  assert.deepEqual(f.state.current.providers.google, { apiKeyEnv: 'GOOGLE_API_KEY', models: [{ id: 'new', contextWindow: 500 }] });
  assert.deepEqual(f.state.current.providers.other, f.original.providers.other); assert.deepEqual(f.state.current.untouched, f.original.untouched);
  assert.deepEqual(f.saved[0].fields, { models: [{ id: 'old', contextWindow: 100 }] }); assert.ok(!JSON.stringify(f.saved).includes('GOOGLE_API_KEY')); assert.ok(!JSON.stringify(f.state.current).includes('DO-NOT-PERSIST'));
});
test('revision is checked again INSIDE official edit callback after disk reconciliation', async () => {
  const f = fixture(), p = await f.preview(); f.state.beforeEdit = () => { f.state.current.providers.other.models = [{ id: 'concurrent' }]; };
  await assert.rejects(f.commit(p), { code: 'REVISION_CONFLICT' }); assert.deepEqual(f.state.current.providers.google, f.original.providers.google); assert.equal(f.saved.length, 1);
});
test('stale revision, invalid model, missing confirmation, changed action and expired token are rejected', async () => {
  let now = 0; const f = fixture({ now: () => now }); await assert.rejects(f.preview('adopt', { revision: 'old' }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(f.preview('adopt', { models: [] }), { code: 'INVALID_MODELS' });
  const p = await f.preview(); await assert.rejects(f.editor.commit({ ...p, confirm: false }, 'adopt'), { code: 'PREVIEW_REQUIRED' }); await assert.rejects(f.editor.commit({ ...p, confirm: true }, 'restore'), { code: 'PREVIEW_REQUIRED' });
  now = 300001; await assert.rejects(f.commit(p), { code: 'PREVIEW_REQUIRED' }); assert.equal(f.state.edits, 0);
});
test('restore deletes models, never writes empty array, and rollback restores exact route fields', async () => {
  const f = fixture(), p = await f.preview('restore'); assert.ok(!Object.hasOwn(p.after, 'models')); const out = await f.commit(p); assert.equal(out.hotReloaded, true); assert.ok(!Object.hasOwn(f.state.current.providers.google, 'models'));
  const back = await f.preview('rollback', { backupId: out.backup.id }); await f.commit(back); assert.deepEqual(f.state.current, f.original);
});
test('adoption removes incompatible overrides but safely backs them up', async () => {
  const f = fixture(); delete f.state.current.providers.google.models; f.state.current.providers.google.modelOverrides = { builtin: { contextWindow: 400 } };
  const p = await f.preview(); assert.equal(p.clearsOverrides, true); await f.commit(p); assert.ok(!Object.hasOwn(f.state.current.providers.google, 'modelOverrides')); assert.deepEqual(f.saved[0].fields, { modelOverrides: { builtin: { contextWindow: 400 } } });
});
test('preflight and backup failures prevent edits; official write errors are sanitized', async () => {
  const a = fixture({ preflightFail: true }); await assert.rejects(a.preview(), { code: 'PREFLIGHT_FAILED' }); assert.equal(a.state.edits, 0);
  const b = fixture({ backupFail: true }), p = await b.preview(); await assert.rejects(b.commit(p)); assert.equal(b.state.edits, 0);
  const c = fixture({ writeFail: true }), q = await c.preview(); await assert.rejects(c.commit(q), error => error.code === 'WRITE_FAILED' && !error.message.includes('sensitive')); assert.deepEqual(c.state.current, c.original); assert.equal(c.saved.length, 1);
});
test('new models may be UNKNOWN_MODEL before adoption, while other metadata failures still block', async () => {
  const f = fixture(); f.ctx.llm.resolveModelInfo = async () => { throw Object.assign(Error('not served yet'), { code: 'UNKNOWN_MODEL' }); };
  const p = await f.preview(); assert.deepEqual(p.unresolved, ['new']); assert.equal(f.state.edits, 0); await f.commit(p); assert.equal(f.state.current.providers.google.models[0].id, 'new');
  const g = fixture(); g.ctx.llm.resolveModelInfo = async () => { throw Object.assign(Error('sensitive'), { code: 'INVALID_CONFIG' }); }; await assert.rejects(g.preview(), { code: 'PREFLIGHT_FAILED' });
});
test('preview token is one-use and payload cannot alter approved fields', async () => {
  const f = fixture(), p = await f.preview(); await f.editor.commit({ ...p, confirm: true, models: [{ id: 'injected' }] }, 'adopt'); assert.equal(f.state.current.providers.google.models[0].id, 'new'); await assert.rejects(f.commit(p), { code: 'PREVIEW_REQUIRED' });
});
test('unknown backup fields and normalized existing values fail closed; prototype IDs remain data', () => {
  assert.throws(() => routeFields({ models: [{ id: 'a', headers: { Authorization: 'secret' } }] }), { code: 'UNSAFE_BACKUP' });
  assert.throws(() => routeFields({ models: [{ id: 'a', name: ' padded ' }] }), { code: 'UNSAFE_BACKUP' });
  const safe = routeFields({ modelOverrides: JSON.parse('{"__proto__":{"contextWindow":100}}') }); assert.equal(Object.hasOwn(safe.modelOverrides, '__proto__'), true);
});
test('disposal before commit prevents writing and missing catalog prevents restore', async () => {
  const f = fixture(), p = await f.preview(); f.editor.dispose(); await assert.rejects(f.commit(p), { code: 'DISPOSED' }); assert.equal(f.state.edits, 0);
  const g = fixture(); g.engine.catalog.list = () => []; await assert.rejects(g.preview('restore'), { code: 'NO_BUILTIN_CATALOG' });
});
test('real backup files are UTF8 without BOM, bounded, path-safe and retain latest five', async () => {
  const base = process.env.DSH_MODEL_TEST_ROOT ?? 'D:/Data/.temp/dsh-model-probe-probe'; await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'backup-test-')), store = new BackupStore(dir);
  for (let i = 0; i < 7; i++) await store.save({ route: 'google', revision: 'r', fields: { models: [{ id: `model-${i}` }] } });
  await store.prune(); const list = await store.list(); assert.equal(list.length, 5); assert.match(list[0].id, /^\d{8}-\d{9}-/);
  const bytes = await readFile(store.path(list[0].id)); assert.equal(bytes[0], 123); assert.ok(!bytes.includes(13)); const restored = await store.read(list[0].id); assert.equal(restored.route, 'google');
  await assert.rejects(store.read('../outside'), { code: 'INVALID_BACKUP' });
  await writeFile(store.path(list[0].id), '{"version":1,"fields":{"secret":"do-not-read"}}'); await assert.rejects(store.read(list[0].id), { code: 'INVALID_BACKUP' });
});
test('repeated failed commits also rotate real backups to five and preserve config', async () => {
  const base = process.env.DSH_MODEL_TEST_ROOT ?? 'D:/Data/.temp/dsh-model-probe-probe'; await mkdir(base, { recursive: true });
  const f = fixture({ writeFail: true }), store = new BackupStore(await mkdtemp(join(base, 'failed-backups-'))); f.editor.backups = store;
  for (let i = 0; i < 7; i++) await assert.rejects(f.commit(await f.preview()), { code: 'WRITE_FAILED' });
  assert.equal((await store.list()).length, 5); assert.deepEqual(f.state.current, f.original);
});
test('cleanup failure never hides original write failure or turns saved config into a failure', async () => {
  const f = fixture({ writeFail: true }); f.editor.backups.prune = async () => { throw Error('sensitive cleanup detail'); };
  await assert.rejects(f.commit(await f.preview()), error => error.code === 'WRITE_FAILED' && error.message.includes('清理失败') && !error.message.includes('sensitive'));
  const g = fixture(); g.editor.backups.prune = f.editor.backups.prune;
  const out = await g.commit(await g.preview()); assert.equal(out.applied, true); assert.ok(out.warning.includes('清理失败')); assert.ok(!out.warning.includes('sensitive'));
});
