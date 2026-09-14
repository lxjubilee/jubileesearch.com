// The model registry: what is loaded, what is loading, what gets evicted.
//
// Models load on first use, not at startup, so the service answers /health in
// milliseconds and a role nobody calls costs nothing.
//
// EVICTION IS NOT A THEORETICAL CONCERN HERE. bge-m3 int8 is 542 MB of weights
// and bge-reranker-v2-m3 int8 is 571 MB, but weights are the small part — the
// working set is several times that. The machine this was written on had 5.5 GB
// free with Postgres, the search engine and a dev server already resident.
// MAX_RESIDENT_MODELS=1 makes the service evict rather than fall over, at the
// cost of a reload when the roles alternate. That trade belongs to whoever runs
// it, so it is configuration, and /health reports which way it is set.

import { env, ROLES } from './config.js';
import { log } from './log.js';
import { selectBackend } from './backends/index.js';

const backend = selectBackend();

/** role -> { model, lastUsed, loadedAt } */
const resident = new Map();
/** role -> Promise, so ten concurrent requests trigger one load, not ten. */
const loading = new Map();

export function state() {
  return {
    backend: backend.describe(),
    max_resident: env.maxResidentModels,
    roles: Object.fromEntries(ROLES.map((role) => {
      const spec = env.models[role];
      const live = resident.get(role);
      return [role, {
        configured: Boolean(spec?.repo),
        model_id: spec?.id || null,
        repo: spec?.repo || null,
        dtype: spec?.dtype || null,
        ...(role === 'embed' ? {
          dimensions: spec?.dim ?? null,
          native_dimensions: live?.model.nativeDim ?? null,
          padded: live?.model.padded ?? null,
        } : {}),
        ...(role === 'rerank' ? { kind: spec?.kind ?? null } : {}),
        loaded: Boolean(live),
        loading: loading.has(role),
        load_ms: live?.model.loadMs ?? null,
        last_used: live?.lastUsed ? new Date(live.lastUsed).toISOString() : null,
      }];
    })),
  };
}

/** True when every preloaded role is resident. Drives /health readiness. */
export function ready() {
  return env.preload.every((role) => resident.has(role));
}

async function evictIfNeeded(incomingRole) {
  if (env.maxResidentModels <= 0) return;
  while (resident.size >= env.maxResidentModels) {
    let oldest = null;
    for (const [role, entry] of resident) {
      if (role === incomingRole) continue;
      if (!oldest || entry.lastUsed < oldest[1].lastUsed) oldest = [role, entry];
    }
    if (!oldest) return;              // nothing evictable; let the load fail honestly
    const [role, entry] = oldest;
    resident.delete(role);
    log.warn('models.evicted', {
      role, model: entry.model.spec.id, max_resident: env.maxResidentModels,
      msg: 'Evicted to make room. If roles alternate, every call now pays a reload — '
         + 'raise MAX_RESIDENT_MODELS if the machine has the memory.',
    });
    try { await entry.model.dispose?.(); } catch (e) { log.warn('models.dispose_failed', { role, err: e.message }); }
  }
}

export async function get(role) {
  const live = resident.get(role);
  if (live) { live.lastUsed = Date.now(); return live.model; }

  const inFlight = loading.get(role);
  if (inFlight) return inFlight;

  const spec = env.models[role];
  const p = (async () => {
    await evictIfNeeded(role);
    log.info('models.loading', { role, model: spec?.id, repo: spec?.repo, dtype: spec?.dtype });
    const model = await backend.load(role, spec);
    resident.set(role, { model, lastUsed: Date.now(), loadedAt: Date.now() });
    return model;
  })();

  loading.set(role, p);
  try { return await p; } finally { loading.delete(role); }
}

/** Load the roles named in PRELOAD, in order. Failures are logged, not fatal. */
export async function preload() {
  for (const role of env.preload) {
    if (!env.models[role]?.repo) {
      log.warn('models.preload_skipped', { role, msg: 'no repository configured for this role' });
      continue;
    }
    try { await get(role); } catch (err) {
      log.error('models.preload_failed', { role, err: err.message });
    }
  }
}

export async function disposeAll() {
  for (const [role, entry] of resident) {
    try { await entry.model.dispose?.(); } catch { /* shutting down anyway */ }
    resident.delete(role);
  }
}
