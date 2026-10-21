import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { aggregateTokens } from '../lib/index.js';

const PRO = 'deepseek-v4-pro';
const FLASH = 'deepseek-flash';
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5 };
const time = new Date(2026, 9, 18, 12).getTime();
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Deliberately distinct flat prices make wrong attribution visible in every cost bucket.
const price = (model) => ({ known: [PRO, FLASH].includes(model), tier: 'test', rates: {
  cacheHit: model === PRO ? [2, 2] : [1, 1],
  cacheMiss: model === PRO ? [4, 4] : [2, 2],
  output: model === PRO ? [8, 8] : [4, 4],
} });
const expectedCost = (model) => model === PRO ? 0.00066 : 0.00033;
const header = (model, time) => ({ type: 'request/header', time, data: { header: { config: { model } } } });
const message = (model, at = time) => ({ type: 'assistant/message', time: at,
  data: { message: { source: { model } }, usage } });

function logs(t, events, filename = 'session.v4.jsonl', id = 'session-1') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tokens-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'workspace', id);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e) + '\n');
  // One compressed frame per event exercises DSH's concatenated frame reader.
  const body = filename.endsWith('.zstd')
    ? Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line)))) : lines.join('');
  writeFileSync(join(dir, filename), body);
  return root;
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} != ${expected}`);
}

function consistent(s) {
  for (const field of ['total', 'input', 'output', 'cacheRead', 'cost', 'costCacheHit', 'costCacheMiss', 'costOutput']) {
    const sum = (records) => Object.values(records).reduce((n, r) => n + r[field], 0);
    near(sum(s.byModel), s[field], `byModel ${field}`);
    near(sum(s.byWorkspace), s[field], `byWorkspace ${field}`);
    near(sum(s.byDay), s[field], `byDay ${field}`);
    for (const [day, d] of Object.entries(s.byDayAll)) {
      near(sum(d.byModel), d[field], `${day} model ${field}`);
    }
    for (const [model, m] of Object.entries(s.byModel)) {
      const daily = Object.values(s.byDay).reduce((n, d) => n + (d.byModel[model]?.[field] ?? 0), 0);
      near(daily, m[field], `${model} daily ${field}`);
    }
  }
  for (const field of ['total', 'cost', 'costCacheHit', 'costCacheMiss', 'costOutput', 'req']) {
    near(Object.values(s.bySession).reduce((n, r) => n + r[field], 0), s[field], `session ${field}`);
  }
  near(Object.values(s.byModel).reduce((n, r) => n + r.req, 0), s.req, 'model requests');
}

function oneModel(s, model) {
  assert.deepEqual(Object.keys(s.byModel), [model]);
  assert.deepEqual(Object.keys(Object.values(s.byDay)[0].byModel), [model]);
  assert.equal(s.total, 155);
  assert.equal(s.byModel[model].reasoning, 5);
  near(s.cost, expectedCost(model), 'event cost');
  near(s.costCacheHit, model === PRO ? 0.00006 : 0.00003, 'cache hit cost');
  near(s.costCacheMiss, model === PRO ? 0.0004 : 0.0002, 'cache miss cost');
  near(s.costOutput, model === PRO ? 0.0002 : 0.0001, 'output + reasoning cost');
  consistent(s);
}

test('minimal committed message without request/header uses its source model', (t) => {
  const event = JSON.parse(readFileSync(new URL('./fixtures/missing-header.jsonl', import.meta.url), 'utf8'));
  const s = aggregateTokens(logs(t, [event]), null, price);
  oneModel(s, PRO);
  assert.equal(s.bySession['session-1'].model, PRO);
  assert.deepEqual(s.unpricedModels, []);
});

test('message source wins over a stale header and conflicting event hints across switches', (t) => {
  const conflict = message(PRO);
  conflict.model = FLASH;
  conflict.data.model = FLASH;
  conflict.data.usage = { ...usage, model: FLASH };
  conflict.data.chunk = { model: FLASH };
  const root = logs(t, [header(FLASH), conflict, message(FLASH), header(PRO), message(PRO)]);
  const s = aggregateTokens(root, null, price);
  assert.equal(s.byModel[PRO].total, 310);
  assert.equal(s.byModel[FLASH].total, 155);
  near(s.byModel[PRO].cost, 2 * expectedCost(PRO), 'pro cost');
  near(s.byModel[FLASH].cost, expectedCost(FLASH), 'flash cost');
  assert.equal(s.bySession['session-1'].model, PRO);
  consistent(s);
});

for (const [name, data, model, context] of [
  ['usage model', { usage: { ...usage, model: PRO }, chunk: { model: FLASH }, model: FLASH }, FLASH],
  ['legacy chunk model', { chunk: { model: PRO, usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30, reasoning_tokens: 5 } } }],
  ['data model', { usage, model: PRO }],
  ['top-level model', { usage }, PRO],
  ['header fallback', { usage }, undefined, header(PRO)],
  ['context fallback', { chunk: { usage } }, undefined, { type: 'request/context', data: { model: PRO } }],
  ['unknown fallback', { usage }],
]) {
  test(`${name} stays consistent across cost and model groups`, (t) => {
    const event = { type: 'assistant/message', time, data, model };
    const s = aggregateTokens(logs(t, [...(context ? [context] : []), event]), null, price);
    const expected = name === 'unknown fallback' ? 'unknown' : PRO;
    oneModel(s, expected);
    assert.deepEqual(s.unpricedModels, expected === 'unknown' ? ['unknown'] : []);
  });
}

for (const filename of ['session.jsonl', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.v4.jsonl.zstd']) {
  test(`reads mixed streaming/committed records from ${filename}`, (t) => {
    const root = logs(t, [header(FLASH),
      { type: 'assistant/chunk', createdAt: time, data: { chunk: { model: PRO,
        usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 30, reasoningTokens: 5 } } } },
      message(FLASH)], filename);
    const s = aggregateTokens(root, null, price);
    assert.equal(s.files, 1);
    assert.equal(s.req, 2);
    assert.equal(s.byModel[PRO].total, 155);
    assert.equal(s.byModel[FLASH].total, 155);
    near(s.cost, 0.00099, 'mixed cost');
    consistent(s);
  });
}

test('rolling cards use local calendar days; selected groups keep the 0.2.2 elapsed cutoff', (t) => {
  const now = new Date(2026, 9, 2, 12).getTime();
  t.mock.timers.enable({ apis: ['Date'], now });
  const at = (offset, hour = 12) => new Date(2026, 9, 2 - offset, hour).getTime();
  const cutoff7 = now - 7 * 86400000;
  const cutoff30 = now - 30 * 86400000;
  const times = [at(0, 0), at(0), at(6, 0), cutoff7 - 1, cutoff7,
    at(29, 0), cutoff30 - 1, cutoff30, at(31)];
  // An out-of-window header must still provide context for a later model-less event.
  const events = [header(PRO, at(40)), ...times.map((time, i) => i % 2
    ? { type: 'assistant/message', time, data: { usage } } : message(FLASH, time))];
  const root = logs(t, events, 'session.v4.jsonl.zstd');
  const snapshots = [null, 7, 30].map((days) => aggregateTokens(root, days, price));
  const [all, seven, thirty] = snapshots;
  for (const s of snapshots) {
    assert.equal(s.today, 2 * 155);
    assert.equal(s.last7, 3 * 155);
    assert.equal(s.last30, 6 * 155);
    near(s.todayCost, 0.00099, 'today cost');
    near(s.last7Cost, 0.00132, '7 calendar days cost');
    near(s.last30Cost, 0.00297, '30 calendar days cost');
    assert.deepEqual(s.byDayAll, all.byDayAll);
    consistent(s);
  }
  assert.equal(all.req, 9);
  assert.equal(seven.req, 4); // cutoff inclusive, one millisecond before excluded
  assert.equal(thirty.req, 7);
  assert.equal(seven.byDay[dayKey(cutoff7)].total, 155);
  assert.equal(thirty.byDay[dayKey(cutoff30)].total, 155);
  assert.equal(seven.byDayAll[dayKey(cutoff7)].total, 310);
});

test('minimal fixture uses Pro rates from the built-in price history', (t) => {
  const event = JSON.parse(readFileSync(new URL('./fixtures/missing-header.jsonl', import.meta.url), 'utf8'));
  const s = aggregateTokens(logs(t, [event]), null);
  near(s.cost, 0.000792, 'Sunday Pro cost');
  near(s.byModel[PRO].cost, 0.000792, 'overall model cost');
  near(Object.values(s.byDay)[0].byModel[PRO].cost, 0.000792, 'daily model cost');
  consistent(s);
});

test('model-less usage follows header/context switches without leaking between sessions', (t) => {
  const bare = { type: 'assistant/message', time, data: { usage } };
  const root = logs(t, [header(PRO), bare, header(FLASH), bare,
    { type: 'request/context', data: { model: PRO } }, bare]);
  const dir = join(root, 'workspace', 'session-2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), JSON.stringify(bare) + '\n');
  const s = aggregateTokens(root, null, price);
  assert.equal(s.byModel[PRO].req, 2);
  assert.equal(s.byModel[FLASH].req, 1);
  assert.equal(s.byModel.unknown.req, 1);
  assert.equal(s.bySession['session-1'].model, PRO);
  assert.equal(s.bySession['session-2'].model, 'unknown');
  consistent(s);
});
