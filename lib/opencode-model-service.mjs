import os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { collectOpencodeModelUsage } from './opencode-model-usage.mjs';

const UNAVAILABLE = { status: 'unavailable', partial: false, providers: [] };
const REFRESH_MS = 120_000;
const SCAN_TIMEOUT_MS = 45_000;
let worker;
let cached;
let pending;

if (!isMainThread) {
  parentPort?.on('message', async (home) => {
    let result;
    try {
      result = await collectOpencodeModelUsage({ home });
    } catch {
      result = UNAVAILABLE;
    }
    parentPort.postMessage(result);
  });
}

function scanInWorker(home) {
  if (!worker) {
    worker = new Worker(new URL(import.meta.url));
    const createdWorker = worker;
    createdWorker.on('error', () => {});
    createdWorker.on('exit', () => {
      if (worker === createdWorker) worker = undefined;
    });
  }
  const active = worker;
  active.ref();
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timeout);
      active.off('message', finish);
      active.off('exit', fail);
      active.off('error', fail);
      active.unref();
      resolve(result);
    };
    const fail = () => finish(UNAVAILABLE);
    const timeout = setTimeout(() => {
      if (worker === active) worker = undefined;
      active.terminate().catch(() => {});
      fail();
    }, SCAN_TIMEOUT_MS);
    active.once('message', finish);
    active.once('exit', fail);
    active.once('error', fail);
    try {
      active.postMessage(home);
    } catch {
      fail();
    }
  });
}

async function readModelUsage(home, force) {
  if (!force && cached?.home === home && cached.expiresAt > Date.now()) return cached.result;
  if (pending) {
    if (pending.home === home) return pending.result;
    await pending.result;
    return readModelUsage(home, force);
  }
  const result = Promise.resolve()
    .then(() => scanInWorker(home))
    .catch(() => UNAVAILABLE)
    .then((scan) => {
      cached = { home, result: scan, expiresAt: Date.now() + (scan.status === 'unavailable' ? 15_000 : REFRESH_MS) };
      return scan;
    })
    .finally(() => { pending = undefined; });
  pending = { home, result };
  return result;
}

export async function opencodeModelUsageForSubscriptions(goConfig, { home = os.homedir(), force = false } = {}) {
  if (goConfig?.enabled === false) return { status: 'ok', partial: false, subscriptions: [] };
  const subscriptions = goConfig?.subscriptions?.length
    ? goConfig.subscriptions
    : [{ id: 'default', provider: 'opencode-go' }];
  const counts = new Map();
  for (const { provider } of subscriptions) counts.set(provider, (counts.get(provider) || 0) + 1);
  const result = await readModelUsage(home, force);
  const providers = new Map(result.providers.map((row) => [row.provider, row]));
  return {
    status: result.status,
    partial: result.partial,
    subscriptions: subscriptions.map(({ id, provider }) => {
      const matched = providers.get(provider);
      const ambiguous = counts.get(provider) > 1;
      return {
        id,
        provider,
        status: ambiguous ? 'ambiguous' : matched ? 'ok' : 'empty',
        models: ambiguous ? [] : matched?.models || [],
        totalTokens: ambiguous ? 0 : matched?.totalTokens || 0,
        unknownTokens: ambiguous ? 0 : matched?.unknownTokens || 0
      };
    })
  };
}
