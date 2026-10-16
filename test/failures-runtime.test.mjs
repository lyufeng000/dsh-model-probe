import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configSnapshot } from '../lib/state.js';
import { ProfileEditor } from '../lib/profile.js';

const runtime = process.env.DSH_MODEL_TEST_RUNTIME, temp = process.env.DSH_MODEL_TEST_ROOT;
const options = { skip: !runtime || !temp, timeout: 20000 };
const load = specifier => import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(specifier)).href);
async function fixture(overlay = false) {
  const root = await mkdtemp(join(temp, 'p5-failure-')), home = join(root, 'home'), dir = join(home, 'profiles', 'model-probe-failure');
  await mkdir(dir, { recursive: true });
  const config = { providers: { google: { models: [{ id: 'gemini-2.5-flash', contextWindow: 1048576, maxTokens: 65536 }] } } };
  const insert = [{ id: 'llm', name: '@deepseek-ai/dsh-llm' }, { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config }];
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'model-probe-failure', private: true, dsh: { profile: { bundles: [] } } }) + '\n');
  const yaml = await load('js-yaml'), patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, yaml.default.dump([{ insert }]));
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const { Context } = await load('@deepseek-ai/cordis'), { Loader } = await load('@deepseek-ai/cordis-plugin-loader');
  const boot = await load('@deepseek-ai/dsh-app-boot'), { ConfigEditor } = await load('@deepseek-ai/dsh-config-editor');
  const ctx = new Context(); new Loader(ctx, { baseUrl: pathToFileURL(runtime + '/').href });
  const resolution = await boot.createRuntimeResolution({ installAnchor: join(runtime, 'package.json'), home });
  new boot.PluginPackages(ctx, { resolution: { ...resolution, profileDir: dir, linkedRoots: [] } });
  const overlays = overlay ? [{ id: 'llm-pi-ai', config }] : [];
  ctx.provide('profileContext', { dir, patchPath, home, overlays, installAnchor: join(runtime, 'package.json') });
  new ConfigEditor(ctx);
  const credentials = ctx.plugin({ name: 'test-no-real-credentials', apply(c) {
    c.provide('credentials', { describe: async () => ({ configured: false }), describeRecord: async () => ({ configured: false }), readRecord: async () => undefined });
  } }); await credentials.await();
  await boot.mountRootInclude(ctx, join(dir, 'cordis.yml'), boot.readProfilePatches('dsh', ctx.profileContext), pathToFileURL(runtime + '/').href);
  await ctx.loader.await();
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'llm-pi-ai');
  assert.ok(entry, JSON.stringify({ entries: [...ctx.loader.entries()].map(row => ({ id: row.id, state: row.fiber?.state, error: row.fiber?.error?.message })), patches: boot.readProfilePatches('dsh', ctx.profileContext) }));
  assert.equal(entry.fiber.state, 2);
  const engine = { snapshot: () => configSnapshot(ctx), jobs: new Map() }, editor = new ProfileEditor(ctx, engine);
  return { ctx, entry, editor, engine, dir, patchPath, close: async () => { editor.dispose(); await ctx.fiber.dispose(); } };
}
const proposed = [{ id: 'p5-new-model', contextWindow: 1000, maxTokens: 200 }];
const prepare = f => f.editor.preview({ route: 'google', revision: f.engine.snapshot().revision, action: 'adopt', models: proposed });
const commit = (f, p) => f.editor.commit({ route: 'google', revision: p.revision, token: p.token, confirm: true }, 'adopt');

test('real official overlay refusal leaves YAML and served models intact; plugin retains safe backup', options, async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(f.patchPath, 'utf8'), served = await f.ctx.llm.listModels('google');
    await assert.rejects(f.ctx.configEditor.edit(f.entry, current => { current.providers.google.models = proposed; return current; }), /overridden by a home patch or command-line overlay/);
    const preview = await prepare(f); await assert.rejects(commit(f, preview), { code: 'WRITE_FAILED' });
    assert.equal(await readFile(f.patchPath, 'utf8'), before); assert.deepEqual(await f.ctx.llm.listModels('google'), served);
    assert.equal((await f.editor.listBackups()).length, 1);
  } finally { await f.close(); }
});
test('real llm-pi-ai schema refusal does not write profile YAML', options, async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.patchPath, 'utf8');
    await assert.rejects(f.ctx.configEditor.edit(f.entry, current => { current.providers.google.models = [{ id: 'invalid', contextWindow: -1 }]; return current; }));
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    assert.equal((await f.ctx.llm.listModels('google'))[0].id, 'gemini-2.5-flash');
  } finally { await f.close(); }
});
test('real unavailable backup directory blocks official edit BEFORE any config write', options, async () => {
  const f = await fixture();
  try {
    // Deterministic Windows filesystem failure: a regular file occupies the directory.
    await writeFile(join(f.dir, '.model-probe-backups'), 'not-a-directory\n');
    const before = await readFile(f.patchPath, 'utf8'), preview = await prepare(f);
    await assert.rejects(commit(f, preview), { code: 'BACKUP_FAILED' });
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    assert.equal((await f.ctx.llm.listModels('google'))[0].id, 'gemini-2.5-flash');
  } finally { await f.close(); }
});
