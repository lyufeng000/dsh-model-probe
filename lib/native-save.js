import { isDeepStrictEqual } from 'node:util';
import { object, reasoningFields } from './model.js';

const exactWrites = new WeakSet();
/** Previewed adoption and backup restoration must write exactly what was approved. */
export function exactModelEdit(change) { exactWrites.add(change); return change; }

function routeIdentity(config) {
  if (!object(config)) return undefined;
  const { models, ...identity } = config;
  return identity;
}

/** Enrich only the model rows the native save actually selected. Do not
 * replace the list, drop other model fields, or undo an explicit removal.
 * Called inside ConfigEditor's locked callback after disk reconciliation.
 */
export function completeNativeModels(next, current, catalogs) {
  let result = next;
  for (const row of catalogs) {
    const target = next?.providers?.[row.route], before = current?.providers?.[row.route];
    if (!Array.isArray(target?.models) || !object(before)) continue;
    const identity = routeIdentity(row.config);
    if (!isDeepStrictEqual(identity, routeIdentity(before)) || !isDeepStrictEqual(identity, routeIdentity(target))) continue;
    const metadata = new Map(row.models.map(model => [model.id, model]));
    const existing = new Map((before.models ?? []).map(model => [model.id, model]));
    let changed = false;
    const models = target.models.map(model => {
      if (!object(model) || Object.hasOwn(model, 'reasoningEfforts') || Object.hasOwn(existing.get(model.id) ?? {}, 'reasoningEfforts')) return model;
      // A caller-supplied serializer override is authoritative; catalog and
      // cached vendor metadata alone cannot prove its effective wire semantics.
      if (object(model.compat) && Object.keys(model.compat).length) return model;
      const reasoningEfforts = reasoningFields(metadata.get(model.id)?.reasoningEfforts);
      if (reasoningEfforts === undefined) return model;
      changed = true;
      return { ...model, reasoningEfforts };
    });
    if (changed) {
      if (result === next) result = { ...next, providers: { ...next.providers } };
      result.providers[row.route] = { ...target, models };
    }
  }
  return result;
}

/** Keep the native confirmation/save UI and official validation, lock and
 * Loader reconciliation. Discovery stays read-only. This wrapper fills the
 * metadata the native candidate-adoption projection currently drops.
 */
export function hookNativeModelSave(ctx, engine) {
  const service = ctx.configEditor, original = service.edit;
  const descriptor = Object.getOwnPropertyDescriptor(service, 'edit');
  let active = true;
  async function edit(entry, change) {
    if (!active || exactWrites.has(change) || entry?.options?.name !== '@deepseek-ai/dsh-llm-pi-ai') return original.call(this, entry, change);
    const catalogs = await engine.savedCatalogs();
    return original.call(this, entry, (current, inherited) => {
      const before = structuredClone(current);
      const next = change(current, inherited);
      return active ? completeNativeModels(next, before, catalogs) : next;
    });
  }
  service.edit = edit;
  return () => {
    active = false;
    // Cordis creates a fresh traceable method proxy on every property read.
    // Compare the stored descriptor, not a scoped proxy's function identity.
    if (Object.getOwnPropertyDescriptor(service, 'edit')?.value !== edit) return;
    if (descriptor) Object.defineProperty(service, 'edit', descriptor);
    else delete service.edit;
  };
}
