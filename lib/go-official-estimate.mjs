import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  applyGoModelLimits,
  buildGoQuotaEstimate,
  firstFullGoCycleDay,
  readGoWorkspaceModelCosts
} from '../public/go-quota-estimate.js';

const EXPORT_URL = 'https://opencode.ai/console/api/v2/usage/export?range=90d';
const CATALOG_URL = 'https://opencode.ai/inference/go/v1/models';
const PLANS = ['go', 'go-plus', 'go-teams'];
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const CATALOG_REFRESH_MS = 60 * 60_000;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const BUNDLED_CATALOG = JSON.parse(readFileSync(new URL('../public/go-model-limits.json', import.meta.url), 'utf8'));

async function readText(response, maxBytes) {
  if (!response.body) throw new Error('Empty OpenCode response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('OpenCode response too large');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function catalogWeights(bundledModels, liveModels = []) {
  const weights = new Map(PLANS.map((plan) => [plan, new Map()]));
  for (const { id, limits } of [...bundledModels, ...liveModels]) {
    if (typeof id !== 'string' || !id.trim()) continue;
    for (const [plan, byModel] of weights) {
      const limit = limits?.[plan];
      if (Number.isFinite(limit) && limit > 0) byModel.set(id.trim().toLowerCase(), limit);
    }
  }
  return weights;
}

export function createGoOfficialEstimateReader({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const fallback = { weights: catalogWeights(BUNDLED_CATALOG.models), date: BUNDLED_CATALOG.retrievedAt };
  let catalog;
  let catalogAfter = 0;
  let catalogPending;
  const subscriptions = new Map();

  function getCatalog() {
    if (catalogPending) return catalogPending;
    if (now() < catalogAfter) return Promise.resolve(catalog || fallback);
    catalogPending = (async () => {
      try {
        const response = await fetchImpl(CATALOG_URL, {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Model catalog unavailable');
        }
        const { data } = JSON.parse(await readText(response, MAX_CATALOG_BYTES));
        const liveModels = data.filter((item) => item?.go?.monthly_usage)
          .map((item) => ({ id: item.id, limits: item.go.monthly_usage }));
        if (!liveModels.length) throw new Error('Model catalog has no Go weights');
        catalog = { weights: catalogWeights(BUNDLED_CATALOG.models, liveModels), date: new Date(now()).toISOString() };
        catalogAfter = now() + CATALOG_REFRESH_MS;
      } catch {
        catalogAfter = now() + RETRY_MS;
      }
      return catalog || fallback;
    })().finally(() => { catalogPending = undefined; });
    return catalogPending;
  }

  async function getEstimate({ key, cycleEnd, from, to }) {
    let csv;
    try {
      const response = await fetchImpl(EXPORT_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'text/csv' },
        redirect: 'error',
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok || !/^(?:text\/csv|application\/csv)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        response.body?.cancel().catch(() => {});
        return { status: response.status === 401 || response.status === 403 ? 'denied' : 'unavailable', cycleEnd };
      }
      csv = await readText(response, MAX_EXPORT_BYTES);
    } catch {
      return { status: 'unavailable', cycleEnd };
    }

    try {
      const { rows, through } = readGoWorkspaceModelCosts(csv, { from, through: to });
      if (!rows.length) return { status: 'pending', cycleEnd };
      const { weights, date } = await getCatalog();
      const estimates = {};
      for (const [plan, limits] of weights) {
        try {
          const report = { cycleEnd, through, rows: applyGoModelLimits(rows, limits) };
          const estimate = buildGoQuotaEstimate(report, cycleEnd);
          if (estimate) estimates[plan] = estimate;
        } catch {
          // A plan without weights for every billed model cannot produce a comparable share.
        }
      }
      if (!Object.keys(estimates).length) return { status: 'incomplete', cycleEnd };
      return { status: 'ok', cycleEnd, from, through, fetchedAt: new Date(now()).toISOString(), catalogDate: date, estimates };
    } catch {
      return { status: 'incomplete', cycleEnd };
    }
  }

  async function read({ id, route, key, cycleEnd, force = false }) {
    const end = Date.parse(cycleEnd);
    if (!key || !Number.isFinite(end) || end <= now()) return { status: 'pending' };
    const from = firstFullGoCycleDay(cycleEnd);
    const to = new Date(now()).toISOString().slice(0, 10);
    if (!from || from > to) return { status: 'pending', cycleEnd };
    const credential = createHash('sha256').update(key).digest('hex');
    let entry = subscriptions.get(id);
    if (entry?.credential !== credential || entry.route !== route || entry.cycleEnd !== cycleEnd) {
      entry = { credential, route, cycleEnd };
      subscriptions.set(id, entry);
    }
    if (entry.pending) return entry.pending;
    if (entry.result && now() < (force ? entry.forceAfter : entry.refreshAfter)) return entry.result;

    entry.pending = getEstimate({ key, cycleEnd, from, to }).then((result) => {
      if (subscriptions.get(id) !== entry || now() >= end) return { status: 'pending' };
      if (result.status === 'ok') entry.good = result;
      if (result.status === 'denied') entry.good = undefined;
      entry.result = entry.good && result.status !== 'ok' ? { ...entry.good, status: 'stale' } : result;
      entry.forceAfter = now() + RETRY_MS;
      entry.refreshAfter = result.status === 'ok' ? now() + REFRESH_MS : entry.forceAfter;
      return entry.result;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }

  return { read, forget: (id) => subscriptions.delete(id) };
}
