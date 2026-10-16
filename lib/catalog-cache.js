import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { modelFields, object, validId } from './model.js';

/** Official settings discovery only keeps these fields, plus inputModalities for adoption. */
export function discoveryModel(model) {
  const clean = modelFields(model);
  if (!validId(clean.id)) return undefined;
  return { ...clean, ...(clean.input ? { inputModalities: [...clean.input] } : {}) };
}

export function catalogIdentity({ route, api, baseURL }) {
  return `${route ?? ''}\n${api ?? ''}\n${baseURL ?? ''}`;
}

function copyModels(models) {
  return models.map(model => ({ ...model, ...(model.input ? { input: [...model.input] } : {}), ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}) }));
}

/** Last live vendor lists. Not cordis.patch.yml: a fetch must not replace the models the user already enabled. */
export class CatalogCache {
  constructor(dir) {
    this.file = dir ? join(dir, '.model-probe-cache', 'catalogs.json') : null;
    this.memory = new Map();
    this.loading = this.file ? this.readDisk() : Promise.resolve();
    this.writes = Promise.resolve();
  }
  async readDisk() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.catalogs)) return;
      for (const entry of data.catalogs) {
        const id = catalogIdentity(entry);
        if (this.memory.has(id) || !object(entry) || typeof entry.api !== 'string' || typeof entry.baseURL !== 'string' || !Array.isArray(entry.models)) continue;
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
      const [route, api, baseURL] = identity.split('\n');
      return { ...(route ? { route } : {}), api, baseURL, ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}), models: entry.models };
    });
    const body = JSON.stringify({ version: 1, catalogs }, null, 2) + '\n';
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await copyFile(tmp, this.file);
    await unlink(tmp).catch(() => {});
  }
}
