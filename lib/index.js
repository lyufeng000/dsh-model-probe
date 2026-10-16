import { ProbeEngine } from './engine.js';
import { ProfileEditor } from './profile.js';
import { createCatalog } from './enrich.js';
import { registerRpcRoutes } from './rpc.js';

function hookModelDiscovery(ctx, manager) {
  const llm = ctx.llm, discoveries = llm?.discoveries;
  if (!(discoveries instanceof Map)) return () => {};
  const originalSet = discoveries.set.bind(discoveries);
  const originals = new Map();
  const wrap = (settingsNs, fn) => {
    if (settingsNs !== 'llm-pi-ai' || typeof fn !== 'function') return fn;
    originals.set(settingsNs, fn);
    const wrapped = (request = {}, signal) => manager.discoverForSettings(request, signal, fn);
    wrapped.__modelProbeWrapped = fn;
    return wrapped;
  };
  for (const [ns, fn] of [...discoveries.entries()]) {
    if (ns === 'llm-pi-ai' && typeof fn === 'function' && !fn.__modelProbeWrapped) {
      originalSet(ns, wrap(ns, fn));
    }
  }
  const hookedSet = (ns, fn) => originalSet(ns, fn?.__modelProbeWrapped ? fn : wrap(ns, fn));
  discoveries.set = hookedSet;
  return () => {
    if (discoveries.set === hookedSet) delete discoveries.set;
    for (const [ns, orig] of originals.entries()) {
      if (discoveries.get(ns)?.__modelProbeWrapped === orig) originalSet(ns, orig);
    }
  };
}

export const name = 'model-probe';
export const inject = ['connection', 'credentials', 'profileContext', 'configEditor', 'loader', 'llm'];
export async function apply(ctx) {
  const [credentials, connection, registry] = await Promise.all([
    ctx.loader.import('@deepseek-ai/dsh-credentials'),
    ctx.loader.import('@deepseek-ai/dsh-client-connection'),
    ctx.loader.import('@earendil-works/pi-ai/providers/all')
  ]);
  const manager = new ProbeEngine(ctx, credentials, { catalog: createCatalog(registry) });
  const editor = new ProfileEditor(ctx, manager);
  ctx.effect(() => {
    const unhook = hookModelDiscovery(ctx, manager);
    const dispose = registerRpcRoutes(ctx, connection.clientRequestSchema, {
      state: () => manager.state(), probe: (payload, signal) => manager.probe(payload, signal), cancel: payload => manager.cancel(payload),
      preview: payload => editor.preview(payload), adopt: payload => editor.commit(payload, 'adopt'), restore: payload => editor.commit(payload, 'restore'),
      rollback: payload => editor.commit(payload, 'rollback'), backups: () => editor.listBackups()
    });
    return async () => { unhook(); editor.dispose(); manager.dispose(); await dispose(); };
  });
}
