import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { modelFields, object, validId } from './model.js';

/** Keep native picker fields plus reasoning metadata for the locked static-save completion. */
export function discoveryModel(model) {
  const clean = modelFields(model);
  if (!validId(clean.id)) return undefined;
  return { ...clean, ...(clean.input ? { inputModalities: [...clean.input] } : {}) };
}

// Version 3 adds a compatibility scope so a catalog fetched under an older
// DSH/pi-ai pair can never feed pre-upgrade reasoning metadata into a native save.
// Bump CACHE_EPOCH whenever the supported DSH/pi-ai pair changes.
export const CACHE_VERSION = 3;
export const CACHE_EPOCH = 'dsh-0.2.1/pi-ai-1.1.0';

export function catalogIdentity({ route, api, baseURL, authScope }) {
  return JSON.stringify([route ?? '', api ?? '', baseURL ?? '', authScope ?? '']);
}

function copyModels(models) {
  return structuredClone(models);
}

/** Last live vendor lists. Not cordis.patch.yml: a fetch must not replace the models the user already enabled. */
export class CatalogCache {
  constructor(dir, { epoch = CACHE_EPOCH, catalogGeneratedAt } = {}) {
    this.file = dir ? join(dir, '.model-probe-cache', 'catalogs.json') : null;
    this.scope = { epoch, catalog: Number.isFinite(catalogGeneratedAt) ? catalogGeneratedAt : null };
    this.memory = new Map();
    this.loading = this.file ? this.readDisk() : Promise.resolve();
    this.writes = Promise.resolve();
  }
  scopeMatches(scope) {
    return object(scope) && scope.epoch === this.scope.epoch
      && (scope.catalog ?? null) === this.scope.catalog;
  }
  async readDisk() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      // v1 mixed credentials; v2/pre-epoch files carry no runtime compatibility scope.
      if (data?.version !== CACHE_VERSION || !this.scopeMatches(data.scope) || !Array.isArray(data.catalogs)) return;
      for (const entry of data.catalogs) {
        if (!object(entry) || !/^[a-f0-9]{64}$/.test(entry.authScope ?? '') || typeof entry.api !== 'string' || typeof entry.baseURL !== 'string' || !Array.isArray(entry.models)) continue;
        const id = catalogIdentity(entry);
        if (this.memory.has(id)) continue;
        const models = entry.models.map(discoveryModel).filter(Boolean);
        if (models.length) this.memory.set(id, { fetchedAt: typeof entry.fetchedAt === 'string' ? entry.fetchedAt : undefined, models });
      }
    } catch { /* A missing or corrupt file is a cache miss, never a failed fetch. */ }
  }
  async read(plan) {
    await this.loading;
    const hit = this.memory.get(catalogIdentity(plan));
    return hit?.models?.length ? copyModels(hit.models) : undefined;
  }
  write(plan, models, fetchedAt = new Date().toISOString()) {
    const clean = models.map(discoveryModel).filter(Boolean);
    if (!clean.length) return Promise.resolve([]);
    this.memory.set(catalogIdentity(plan), { fetchedAt, models: clean });
    if (!this.file) return Promise.resolve(copyModels(clean));
    const op = this.writes.then(async () => { await this.loading; await this.flush(); });
    this.writes = op.catch(() => {});
    return op.then(() => copyModels(clean));
  }
  async flush() {
    const catalogs = [...this.memory.entries()].map(([identity, entry]) => {
      const [route, api, baseURL, authScope] = JSON.parse(identity);
      return { ...(route ? { route } : {}), api, baseURL, authScope, ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}), models: entry.models };
    });
    const body = JSON.stringify({ version: CACHE_VERSION, scope: this.scope, catalogs }, null, 2) + '\n';
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await copyFile(tmp, this.file);
    await unlink(tmp).catch(() => {});
  }
}
