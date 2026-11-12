'use strict';
/**
 * Тесты обновления каталога: пустой/оборванный обход не должен затирать данные,
 * успешный — атомарно подменяет каталог, старый кэш загружается (stale-while-revalidate).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-refresh-'));
process.env.MM_CACHE_DIR = cacheDir;
process.env.MM_CATALOG_TTL = '3600000'; // 1 час, чтобы проще проверять stale

const registry = require('../registry');

const makeSource = (count, ageMs = 0) => ({
  id: 'fake',
  items: Array.from({ length: count }, (_, i) => ({ extId: String(i), title: 'Work ' + i, url: 'u', cover: null })),
  ready: true,
  posts: count,
  builtAt: Date.now() - ageMs,
  scanned: 1,
  error: null,
  stale: ageMs > 3600000,
  failures: 0,
  nextTry: 0,
});

const adapter = (pages) => ({
  maxPages: pages.length,
  catalogPage: async (p) => pages[p - 1] || [],
});

test('пустой обход не затирает каталог и уходит в ретрай', async () => {
  const s = makeSource(100, 2 * 3600e3);
  const ok = await registry._crawlSource(s, adapter([[], []]));
  assert.equal(ok, false);
  assert.equal(s.items.length, 100);
  assert.equal(s.posts, 100);
  assert.equal(s.ready, true);
  assert.match(s.error, /пуст/);
  assert.equal(s.failures, 1);
  assert.ok(s.nextTry > Date.now());
});

test('оборванный обход (<50% обычного) не затирает каталог', async () => {
  const s = makeSource(100, 2 * 3600e3);
  const ten = Array.from({ length: 10 }, (_, i) => ({ extId: 'n' + i, title: 'New ' + i, url: 'u', cover: null }));
  const ok = await registry._crawlSource(s, adapter([ten, []]));
  assert.equal(ok, false);
  assert.equal(s.items.length, 100);
  assert.match(s.error, /короче/);
});

test('успешный обход атомарно подменяет каталог и сбрасывает ошибки', async () => {
  const s = makeSource(2, 2 * 3600e3);
  s.error = 'старая ошибка';
  s.failures = 3;
  const fresh = [
    { extId: '10', title: 'A', url: 'u', cover: null },
    { extId: '11', title: 'B', url: 'u', cover: null },
    { extId: '12', title: 'C', url: 'u', cover: null },
  ];
  const before = s.builtAt;
  const ok = await registry._crawlSource(s, adapter([fresh, []]));
  assert.equal(ok, true);
  assert.deepEqual(s.items.map((x) => x.extId), ['10', '11', '12']);
  assert.equal(s.posts, 3);
  assert.equal(s.error, null);
  assert.equal(s.failures, 0);
  assert.equal(s.nextTry, 0);
  assert.equal(s.stale, false);
  assert.ok(s.builtAt > before);
});

test('loadSource поднимает просроченный кэш и помечает stale', () => {
  const old = Date.now() - 5 * 3600e3;
  fs.writeFileSync(path.join(cacheDir, 'catalog-fake.json'), JSON.stringify({
    builtAt: old, scanned: 7, items: [{ extId: '1', title: 'X', url: 'u', cover: null }],
  }));
  const s = { id: 'fake' };
  assert.equal(registry._loadSource(s), true);
  assert.equal(s.items.length, 1);
  assert.equal(s.stale, true);
  assert.equal(registry.isStale(s), true);
});

test('isStale: свежий каталог не считается просроченным', () => {
  assert.equal(registry.isStale({ ready: true, builtAt: Date.now() - 10 * 60e3 }), false);
  assert.equal(registry.isStale({ ready: false, builtAt: Date.now() - 10 * 3600e3 }), false);
});

test.after(() => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
