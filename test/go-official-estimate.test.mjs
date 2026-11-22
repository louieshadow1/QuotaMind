import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoOfficialEstimateReader } from '../lib/go-official-estimate.mjs';

const GOOGLE_CYCLE = '2026-11-25T11:22:42.000Z';
const GITHUB_CYCLE = '2026-11-30T09:09:00.000Z';
const GOOGLE = { id: 'google', route: 'opencode-go', key: 'google-fixture', cycleEnd: GOOGLE_CYCLE };
const GITHUB = { id: 'github', route: 'opencode-go2', key: 'github-fixture', cycleEnd: GITHUB_CYCLE };
const LIMITS = { go: 10, 'go-plus': 20, 'go-teams': 15 };

function model(id, limits = LIMITS) {
  return { id, go: { monthly_usage: limits } };
}

function csv(rows) {
  return new Response(['day,provider,model,cost_usd,user_id', ...rows].join('\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' }
  });
}

function fixture(exportResponse) {
  let time = Date.parse('2026-11-22T12:00:00Z');
  let catalogCalls = 0;
  const bearers = [];
  const reader = createGoOfficialEstimateReader({
    now: () => time,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url === 'https://opencode.ai/inference/go/v1/models') {
        assert.equal(options.headers.Authorization, undefined);
        catalogCalls += 1;
        return Response.json({ data: ['alpha', 'beta', 'gamma', 'delta'].map((id) => model(id)) });
      }
      assert.equal(url, 'https://opencode.ai/console/api/v2/usage/export?range=90d');
      bearers.push(options.headers.Authorization);
      return exportResponse(options.headers.Authorization);
    }
  });
  return { ...reader, bearers, catalogCalls: () => catalogCalls, advanceTo: (date) => { time = Date.parse(date); } };
}

test('workspace exports are separate, filtered by renewal, and ranked with all models in the denominator', async () => {
  const reader = fixture((bearer) => bearer === 'Bearer google-fixture' ? csv([
    '2026-10-25,opencode-go,delta,300,fixture-user-id',
    '2026-10-26,opencode-go,alpha,4,fixture-user-id',
    '2026-11-21,opencode-go,beta,3,fixture-user-id',
    '2026-11-21,opencode-go,gamma,2,fixture-user-id',
    '2026-11-21,opencode-go,delta,1,fixture-user-id',
    '2026-11-22,opencode,delta,200,fixture-user-id',
    '2026-11-23,opencode-go,delta,300,fixture-user-id'
  ]) : csv([
    '2026-10-30,opencode-go,alpha,200,fixture-user-id',
    '2026-10-31,opencode-go,beta,5,fixture-user-id'
  ]));
  const [google, github, concurrent] = await Promise.all([reader.read(GOOGLE), reader.read(GITHUB), reader.read(GOOGLE)]);
  assert.equal(concurrent, google);
  assert.deepEqual(reader.bearers, ['Bearer google-fixture', 'Bearer github-fixture']);
  assert.equal(reader.catalogCalls(), 1);
  assert.equal(google.from, '2026-10-26');
  assert.equal(github.from, '2026-10-31');
  assert.equal(google.through, '2026-11-21');
  assert.equal(google.estimates.go.modelCount, 4);
  assert.deepEqual(google.estimates.go.models.map(({ model, sharePercent }) => ({
    model, sharePercent: Number(sharePercent.toFixed(8))
  })), [
    { model: 'alpha', sharePercent: 40 },
    { model: 'beta', sharePercent: 30 },
    { model: 'gamma', sharePercent: 20 }
  ]);
  assert.deepEqual(github.estimates.go.models, [{ model: 'beta', sharePercent: 100 }]);
  assert.doesNotMatch(JSON.stringify([google, github]), /fixture-user-id|google-fixture|github-fixture|costUsd|cost_usd/);
});

test('refresh deduplicates work and keeps only same-cycle data for transient failures', async () => {
  let healthy = true;
  const reader = fixture(() => healthy ? csv(['2026-11-21,opencode-go,alpha,5,fixture']) : new Response('', { status: 503 }));
  const initial = await reader.read(GOOGLE);
  assert.equal(initial.status, 'ok');
  healthy = false;
  reader.advanceTo('2026-11-22T12:01:01Z');
  assert.equal((await reader.read(GOOGLE)).status, 'ok');
  assert.equal((await reader.read({ ...GOOGLE, force: true })).status, 'stale');
  assert.equal(reader.bearers.length, 2);
  assert.equal((await reader.read({ ...GOOGLE, key: 'new-fixture' })).status, 'unavailable');
  assert.equal((await reader.read({ ...GOOGLE, cycleEnd: '2026-12-25T11:22:42.000Z' })).status, 'pending');
});

test('access denial clears auto history and unweighted or out-of-period data produces no estimate', async () => {
  let response = () => csv(['2026-11-21,opencode-go,alpha,5,fixture']);
  const reader = fixture(() => response());
  assert.equal((await reader.read(GOOGLE)).status, 'ok');
  response = () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('fixture response stream failed')); }
  }), { status: 403 });
  reader.advanceTo('2026-11-22T12:07:00Z');
  assert.deepEqual(await reader.read(GOOGLE), { status: 'denied', cycleEnd: GOOGLE_CYCLE });
  response = () => csv(['2026-11-21,opencode-go,new-model-unknown,5,fixture']);
  assert.equal((await reader.read(GITHUB)).status, 'incomplete');
  response = () => csv(['2026-10-25,opencode-go,alpha,5,fixture']);
  reader.advanceTo('2026-11-22T12:09:00Z');
  assert.equal((await reader.read(GOOGLE)).status, 'pending');
});

test('a reset or credential change while an export is pending discards old data', async () => {
  let release;
  const reader = fixture((bearer) => bearer === 'Bearer google-fixture'
    ? new Promise((resolve) => { release = resolve; })
    : csv(['2026-11-21,opencode-go,beta,5,fixture']));
  const original = reader.read(GOOGLE);
  reader.forget(GOOGLE.id);
  const current = await reader.read({ ...GOOGLE, key: 'replacement-fixture' });
  release(csv(['2026-11-21,opencode-go,alpha,5,fixture']));
  assert.equal((await original).status, 'pending');
  assert.equal(current.estimates.go.models[0].model, 'beta');
});
