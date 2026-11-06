'use strict';
/**
 * Реестр источников и слияние каталогов без дублей.
 *
 * Каждый адаптер отдаёт: id, name, base, catalogPage(n), detail(id), chapters(id), pages(chapterId),
 * опционально tags() и tagPage(slug, n).
 *
 * Слияние: работы группируются по workKey (нормализованное название), поэтому одна и та же
 * манга с двух сайтов попадает в список один раз, а в карточке остаётся sources[].
 */
const fs = require('node:fs');
const path = require('node:path');
const { workKey, tagKey, stripTags, stripChapterSuffix } = require('./http');
const tagsIndex = require('./tags');

/** Название работы для показа: без хвоста «- глава N» / «- часть N». */
const displayTitle = (t) => stripChapterSuffix(t) || String(t);

const CACHE_DIR = path.join(__dirname, '..', 'cache');

const adapters = [
  require('./mm'),
  require('./moody'),
  require('./nudemoon'),
  require('./sexbase'),
];

const TTL = Number(process.env.MM_CATALOG_TTL || 12 * 3600 * 1000);

const state = {
  sources: adapters.map((a) => ({
    id: a.id, name: a.name, base: a.base,
    ready: false, scanned: 0, works: 0, posts: 0, builtAt: 0, error: null,
    items: [],
  })),
  merged: null,       // [{ key, title, cover, primary: {source, extId}, sources: [...] }]
  mergedAt: 0,
  crawling: false,
};

const cacheFile = (id) => path.join(CACHE_DIR, `catalog-${id}.json`);

function saveSource(s) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(s.id), JSON.stringify({ builtAt: s.builtAt, scanned: s.scanned, items: s.items }));
  } catch (e) { console.error(`[${s.id}] save failed:`, e.message); }
}

function loadSource(s) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(s.id), 'utf8'));
    if (!raw.items?.length || Date.now() - raw.builtAt > TTL) return false;
    s.items = raw.items;
    s.builtAt = raw.builtAt;
    s.scanned = raw.scanned || 0;
    s.posts = raw.items.length;
    s.ready = true;
    return true;
  } catch { return false; }
}

function groupSource(s) {
  const byKey = new Map();
  for (const item of s.items) {
    const key = workKey(item.title);
    if (!key) continue;
    let g = byKey.get(key);
    if (!g) {
      g = { key, title: displayTitle(item.title), cover: item.cover, sources: [], _min: Infinity, count: 0, primary: null };
      byKey.set(key, g);
    }
    g.count += 1;
    // в sources — только одна запись на источник (первая по возрастанию id), иначе
    // в карточке окажутся все главы этой же работы
    const num = Number(item.extId);
    if (num < g._min) {
      g._min = num;
      g.primary = { source: s.id, extId: item.extId, url: item.url };
      g.cover = item.cover || g.cover;
      g.title = displayTitle(item.title);
    }
  }
  s.works = byKey.size;
  return [...byKey.values()].map((g) => ({ ...g, sources: g.primary ? [g.primary] : [] }));
}

function buildMerged() {
  const mergedByKey = new Map();
  const order = [];

  // источники отдают каталог от новых к старым; сливаем «вперемешку» по позициям,
  // чтобы в общем списке были работы всех сайтов, а не сначала один источник
  const lists = state.sources.map((s) => groupSource(s));
  const maxLen = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const g = list[i];
      if (!g) continue;
      const cur = mergedByKey.get(g.key);
      if (!cur) {
        const item = { key: g.key, title: g.title, cover: g.cover, primary: g.sources[0], sources: [...g.sources] };
        mergedByKey.set(g.key, item);
        order.push(item);
      } else {
        // источник уже есть — добавляем только новый, чтобы не дублировать
        for (const src of g.sources) {
          if (!cur.sources.some((x) => x.source === src.source)) cur.sources.push(src);
        }
        if (!cur.cover && g.cover) cur.cover = g.cover;
      }
    }
  }
  state.merged = order;
  state.mergedAt = Date.now();
}

async function crawlSource(s) {
  const adapter = adapters.find((a) => a.id === s.id);
  const max = adapter.maxPages || 200;
  const items = [];
  const seen = new Set();
  let misses = 0;
  try {
    for (let p = 1; p <= max; p++) {
      const list = await adapter.catalogPage(p).catch(() => []);
      if (!list.length) { misses += 1; if (misses >= 3) break; continue; }
      misses = 0;
      for (const c of list) {
        if (seen.has(c.extId)) continue;
        seen.add(c.extId);
        items.push({ extId: c.extId, title: c.title, url: c.url, cover: c.cover });
      }
      s.scanned = p;
      s.items = items;
      if (p % 50 === 0) console.log(`[${s.id}] ${p} стр., ${items.length} постов`);
    }
    s.builtAt = Date.now();
    s.posts = items.length;
    s.ready = true;
    saveSource(s);
    console.log(`[${s.id}] каталог готов: ${items.length} постов за ${s.scanned} стр.`);
  } catch (e) {
    s.error = e.message;
    console.error(`[${s.id}] crawl failed:`, e.message);
  }
}

async function warm() {
  const toCrawl = state.sources.filter((s) => !loadSource(s));
  if (!toCrawl.length) {
    buildMerged();
    console.log('[catalog] все источники из кэша, работ:', state.merged.length);
    return;
  }
  state.crawling = true;
  await Promise.all(toCrawl.map((s) => crawlSource(s)));
  state.crawling = false;
  buildMerged();
  console.log('[catalog] слияние готово, уникальных работ:', state.merged.length);
}

function parseId(id) {
  const m = String(id).match(/^([a-z0-9]+)[:_](.+)$/i);
  if (m && adapters.some((a) => a.id === m[1])) return { source: m[1], extId: m[2] };
  if (/^\d+$/.test(id)) return { source: 'mm', extId: id }; // обратная совместимость
  return null;
}

const findAdapter = (id) => adapters.find((a) => a.id === id);

function listPage(page, perPage, sourceId, sort = 'new') {
  if (!state.merged) return null;
  let list = state.merged;
  if (sourceId) list = list.filter((w) => w.sources.some((s) => s.source === sourceId));
  if (sort === 'old') list = [...list].reverse();
  return list.slice((page - 1) * perPage, page * perPage).map((w) => ({
    id: `${w.primary.source}:${w.primary.extId}`,
    title: w.title,
    cover: w.cover,
    author: '',
    genres: [],
    sources: w.sources.map((s) => ({ source: s.source, id: s.extId, url: s.url })),
  }));
}

/**
 * Единый список тегов: собранные из постов (с настоящими slug'ами) + списки источников.
 * Для каждого тега храним slug'и по источникам — фильтр подставляет их, а не угадывает.
 */
async function tagsList() {
  return cachedTags(async () => {
    const map = new Map(); // key -> { key, name, sources: Map(source -> slug) }
    const add = (source, slug, name) => {
      const display = String(name || slug).trim();
      const k = tagKey(display) || tagKey(slug);
      if (!k) return;
      let e = map.get(k);
      if (!e) { e = { key: k, name: display, sources: new Map() }; map.set(k, e); }
      const cyr = /[а-яё]/i;
      if (cyr.test(display) && !cyr.test(e.name)) e.name = display;
      if (!e.sources.has(source)) e.sources.set(source, slug);
    };

    for (const t of tagsIndex.all()) add(t.source, t.slug, t.name);
    for (const a of adapters) {
      if (!a.tags) continue;
      const list = await a.tags().catch(() => []);
      for (const t of list) add(a.id, t.slug, t.name);
    }

    return [...map.values()]
      .map((e) => ({
        key: e.key,
        name: e.name,
        slug: [...e.sources.values()][0],
        sources: [...e.sources.entries()].map(([source, slug]) => ({ source, slug })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });
}

const TAG_TTL = 10 * 60 * 1000;
let tagCache = { at: 0, list: [] };

async function cachedTags(fn) {
  if (Date.now() - tagCache.at < TAG_TTL && tagCache.list.length) return tagCache.list;
  const list = await fn();
  tagCache = { at: Date.now(), list };
  return list;
}

async function tags(page, perPage, sourceId) {
  let list = await tagsList();
  if (sourceId) list = list.filter((t) => t.sources.some((s) => s.source === sourceId));
  const start = (page - 1) * perPage;
  return list.slice(start, start + perPage);
}

/** Значение из ?tag= (канонический ключ или slug) → slug конкретного источника. */
async function slugFor(sourceId, value) {
  const list = await tagsList();
  const byKey = list.find((t) => t.key === value || t.name.toLowerCase() === value.toLowerCase());
  if (byKey) {
    const hit = byKey.sources.find((s) => s.source === sourceId);
    return hit ? hit.slug : null;
  }
  const bySlug = list.find((t) => t.sources.some((s) => s.source === sourceId && s.slug === value));
  if (bySlug) return value;
  return null;
}

function invalidateTagCache() { tagCache = { at: 0, list: [] }; }

module.exports = { state, adapters, warm, parseId, findAdapter, listPage, tags, tagsList, slugFor, invalidateTagCache };
