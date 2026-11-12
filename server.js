'use strict';
/**
 * MangaReader API — мультиисточниковый прокси.
 *
 *   GET /api/manga?page=1[&source=nudemoon][&tag=<slug>]
 *   GET /api/tags
 *   GET /api/manga/:id                 (id = "mm:16737" | "nudemoon:31471" | "16737")
 *   GET /api/manga/:id/chapters
 *   GET /api/chapter/:id/pages
 *   GET /api/sources
 *   GET /demo
 *
 * Слияние источников — по нормализованному названию работы (см. sources/index.js),
 * поэтому одна и та же манга с двух сайтов попадает в каталог один раз.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('./registry');
const { workKey, tagKey, stripChapterSuffix } = require('./http');
const tagsIndex = require('./tags');

const CONFIG = {
  PORT: Number(process.env.PORT || 3001),
  PER_PAGE: Number(process.env.MM_PER_PAGE || 20),
};

const state = registry.state;

const zlib = require('node:zlib');
const gzip = (buf) => zlib.gzipSync(buf, { level: 6 });
const brotli = (buf) => zlib.brotliCompressSync(buf, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
  },
});

/** Отдаёт буфер с gzip, если клиент это умеет (телефон на мобильном интернете — важно). */
function send(res, code, buf, type, extra = {}) {
  const headers = {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'public, max-age=60',
    Vary: 'Accept-Encoding',
    ...extra,
  };
  const accepts = String(res.req?.headers['accept-encoding'] || '');
  if (buf.length > 1024) {
    if (/\bbr\b/.test(accepts)) {
      buf = brotli(buf);
      headers['Content-Encoding'] = 'br';
    } else if (/\bgzip\b/.test(accepts)) {
      buf = gzip(buf);
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(buf);
}

function json(res, code, body) {
  send(res, code, Buffer.from(JSON.stringify(body), 'utf8'), 'application/json; charset=utf-8');
}

/**
 * Полный набор работ по тегу у источника: листаем страницы тега (а не одну),
 * иначе пересечение двух тегов видит только первые 20 карточек каждого.
 */
const tagSetCache = new Map();
async function sourceTagSet(a, slug) {
  const key = `${a.id}:${slug}`;
  const hit = tagSetCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  // диск-кэш: после перезапуска первый запрос по тегу тоже мгновенный
  const safe = String(slug).replace(/[^a-z0-9а-яё-]+/gi, "_").slice(0, 60);
  const diskFile = path.join(registry.CACHE_DIR, `tagset-${a.id}-${safe}.json`);
  try {
    if (!diskFile) throw new Error('no cache dir');
    const raw = JSON.parse(fs.readFileSync(diskFile, "utf8"));
    if (raw && Date.now() - raw.at < 6 * 3600e3 && Array.isArray(raw.items)) {
      const cachedMap = new Map(raw.items.map((it) => [it.key || workKey(it.title), it]));
      tagSetCache.set(key, { exp: Date.now() + 60 * 60e3, value: cachedMap });
      return cachedMap;
    }
  } catch { /* кэша ещё нет */ }

  const maxPages = Number(process.env.MM_TAG_PAGES || 3);
  const map = new Map();
  for (let p = 1; p <= maxPages; p++) {
    const items = await a.tagPage(slug, p).catch(() => []);
    if (!items.length) break;
    for (const it of items) {
      const k = workKey(it.title);
      if (!k || map.has(k)) continue;
      map.set(k, { key: k, source: a.id, extId: it.extId, title: it.title, cover: it.cover, url: it.url });
    }
  }
  tagSetCache.set(key, { exp: Date.now() + 60 * 60e3, value: map });
  capMap(tagSetCache, 500);
  try { fs.writeFileSync(diskFile, JSON.stringify({ at: Date.now(), items: [...map.values()] })); } catch { /* только чтение диска */ }
  return map;
}

/**
 * Работы, отфильтрованные по тегам (строгое И): работа должна быть во всех выбранных тегах.
 * Источники без поддержки тегов в такой фильтр не попадают.
 */
const taggedCache = new Map(); // готовые страницы по тегам: повторные открытия мгновенные

const TAG_COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

async function taggedList(tags, page, perPage, sort = 'new') {

  const cacheKey = [...tags].sort().join('\u0001') + '#' + page + '#' + perPage + '#' + sort;
  const cachedHit = taggedCache.get(cacheKey);
  if (cachedHit && cachedHit.exp > Date.now()) return cachedHit.value;

  const sets = [];
  const TAG_SOURCE_TIMEOUT = Number(process.env.MM_TAG_TIMEOUT || 2000);

  for (const tag of tags) {
    const merged = new Map();
    // источники опрашиваем параллельно и с потолком по времени: раньше медленный сайт
    // (или лежащий hchan) держал весь запрос, и через туннель возвращался 502
    const sources = registry.adapters.filter((a) => a.tagPage);
    const results = await Promise.all(sources.map(async (a) => {
      const slug = registry.slugForFast(a.id, tag) || tag;
      const map = await withTimeout(sourceTagSet(a, slug), TAG_SOURCE_TIMEOUT, 'tag:' + a.id).catch(() => new Map());
      return map;
    }));

    for (const map of results) {
      for (const [k, it] of map) {
        const cur = merged.get(k);
        if (!cur) {
          merged.set(k, {
            id: `${it.source}:${it.extId}`,
            title: registry.displayTitle(it.title), // та же подпись, что и в каталоге
            cover: it.cover,
            author: '',
            genres: [],
            sources: [{ source: it.source, id: it.extId, url: it.url }],
          });
        } else if (!cur.sources.some((s) => s.source === it.source)) {
          cur.sources.push({ source: it.source, id: it.extId, url: it.url });
        }
      }
    }
    sets.push(merged);
  }

  const base = sets[0] || new Map();
  const out = [];
  for (const [key, item] of base) {
    if (sets.slice(1).every((s) => s.has(key))) out.push(item);
  }

  // сортировка внутри выдачи по тегу: раньше режимы az/za здесь просто игнорировались
  if (sort === 'az' || sort === 'za') {
    const keyOf = (it) => registry.sortKey(registry.displayTitle(it.title));
    out.sort((a, b) => TAG_COLLATOR.compare(keyOf(a), keyOf(b)));
    if (sort === 'za') out.reverse();
  } else if (sort === 'old') {
    out.reverse();
  }

  const start = (page - 1) * perPage;
  const result = out.slice(start, start + perPage);
  taggedCache.set(cacheKey, { exp: Date.now() + 10 * 60e3, value: result });
  capMap(taggedCache, 200);
  return result;
}

/** Догружает автора/жанры для карточек (и попутно пополняет индекс тегов). */
/**
 * Обогащение карточек. Раньше тянуло detail+chapters для каждого элемента на каждый запрос —
 * из-за медленных источников (hchan, desu) страница каталога открывалась до 86 секунд.
 * Теперь: кэш на 10 минут + общий бюджет времени, чтобы ответ не ждал вечно.
 */
const enrichCache = new Map(); // id -> { exp, data }
const ENRICH_BUDGET_MS = Number(process.env.MM_ENRICH_BUDGET || 700);
const ENRICH_ITEM_MS = Number(process.env.MM_ENRICH_ITEM || 3500); // потолок на одну карточку
const ENRICH_TTL_MS = 10 * 60e3;
const ENRICH_PARTIAL_TTL_MS = 2 * 60e3;

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms)),
]);

async function enrichWorks(items, budgetMs = ENRICH_BUDGET_MS) {
  const now = Date.now();
  const pending = [];
  for (const it of items) {
    const hit = enrichCache.get(it.id);
    if (hit && hit.exp > now) {
      Object.assign(it, hit.data);
    } else {
      pending.push(it);
    }
  }
  if (!pending.length) return items;

  const work = async (slice) => {
    await Promise.all(slice.map(async (it) => {
      const parsed = registry.parseId(it.id);
      if (!parsed) return;
      const a = registry.findAdapter(parsed.source);
      if (!a) return;
      // каждый запрос ограничен своим таймаутом: один лежащий сайт не должен тормозить всю выдачу
      const d = await withTimeout(a.detail(parsed.extId), ENRICH_ITEM_MS, 'detail').catch(() => null);
      if (!d) { it.drop = true; return; }
      if (parsed.source !== 'mm') {
        const chs = await withTimeout(a.chapters(parsed.extId), ENRICH_ITEM_MS, 'chapters').catch(() => null);
        if (!Array.isArray(chs)) { it.partial = true; return; } // источник не ответил — карточку не выкидываем
        if (!chs.length) { it.drop = true; return; }
      }
      it.author = d.author || '';
      it.genres = d.genres || [];
      it.cover = it.cover || d.cover || '';
      it.date = d.date || null;
      enrichCache.set(it.id, {
        exp: Date.now() + ENRICH_TTL_MS,
        data: { author: it.author, genres: it.genres, cover: it.cover, date: it.date },
      });
    }));
  };

  const chunk = 6;
  const runner = (async () => {
    for (let i = 0; i < pending.length; i += chunk) {
      await work(pending.slice(i, i + chunk));
    }
  })();

  // ответ не ждёт больше бюджета, обогащение продолжается в фоне
  await withTimeout(runner, budgetMs, 'budget').catch(() => {});

  for (const it of pending) {
    if (!enrichCache.has(it.id)) {
      enrichCache.set(it.id, {
        exp: Date.now() + ENRICH_PARTIAL_TTL_MS,
        data: { author: it.author || '', genres: it.genres || [], cover: it.cover || '', date: it.date || null },
      });
    }
  }
  // ВАЖНО: не сбрасываем кэш списка тегов — enrichWorks вызывается на каждый запрос каталога,
  // из-за этого tagsList пересобирался (с сетевыми запросами) и тег открывался по 15-20 секунд.
  return items;
}
/**
 * Главы работы со ВСЕХ источников, где она есть: объединяем по номеру главы,
 * чтобы список был единым (у одного сайта пост = глава, у другого — том/пачка глав).
 */
async function mergedChapters(workTitle, seed) {
  const key = workKey(workTitle);
  const entry = state.merged?.find((w) => w.key === key);
  let refs = entry ? entry.sources : [];
  // работа могла не попасть в объединённый индекс — тогда её собственный источник и есть первый
  if (seed && !refs.some((r) => r.source === seed.source && r.extId === seed.extId)) {
    refs = [seed, ...refs];
  }

  const slow = [];
  const lists = await Promise.all(refs.map(async (r) => {
    const a = registry.findAdapter(r.source);
    if (!a) return [];
    // у mm поиск глав по сайту — до 30 секунд; через туннель это 502, поэтому
    // каждый источник ограничен по времени, а недоделанное дочитывается в фоне
    const isSeed = seed && r.source === seed.source && r.extId === seed.extId;
    const budget = isSeed ? 2000 : 1500;
    const sibs = registry.siblings(r.source, workTitle);
    const sibByExt = new Map(sibs.map((s) => [s.extId, s]));

    let chs = null;
    if (sibs.length >= 1) {
      // вся серия уже есть в каталоге — на сайт не ходим (у mm поиск глав занимал до 30 с)
      chs = sibs.map((s) => ({ extId: s.extId, number: s.part ?? null, title: s.title, date: null }));
    } else {
      try {
        chs = await withTimeout(a.chapters(r.extId), budget, 'chapters:' + r.source);
      } catch {
        slow.push(r);
        chs = [];
      }
    }

    const mapped = chs.map((c) => {
      // если адаптер не знает номер части (у zakura/nudemoon пост = часть серии),
      // берём его из индекса каталога: «…ты 5» → номер 5
      const sib = sibByExt.get(c.extId);
      const num = sib && sib.part != null ? sib.part : c.number;
      return {
        id: `${r.source}:${c.extId}`,
        number: num ?? null,
        volume: c.volume ?? null,
        order: sib && sib.part != null ? sib.part : (c.order ?? c.number),
        title: c.title,
        date: c.date,
        source: r.source,
      };
    });

    // остальные посты серии из индекса: это главы той же карточки, а не отдельные работы
    for (const sib of sibs) {
      if (mapped.some((c) => c.id === `${r.source}:${sib.extId}`)) continue;
      mapped.push({
        id: `${r.source}:${sib.extId}`,
        number: sib.part ?? null,
        volume: null,
        order: sib.part ?? null,
        title: sib.title,
        date: null,
        source: r.source,
      });
    }
    return mapped;
  }));

  // --- склейка одинаковых глав из разных источников ---
  // Одна и та же глава часто лежит на двух сайтах с разными подписями и номерами
  // («Поедающие доставщиков жёны» = zakura гл.1 и mm гл.2). Признак: у источника
  // ровно одна глава этой работы и её название после нормализации совпадает.
  // сравнение по русской части названия: «Волнующее похищение (Tokimeki Abduction)»
  // и «Tokimeki Abduction / Волнующее похищение» — одна и та же глава
  const sigOf = (t) => {
    const base = String(t || "").toLowerCase().replace(/ё/g, "е");
    const ru = base.replace(/[^а-я]+/g, " ").trim();
    if (ru) return ru;
    return base.replace(/[^0-9a-zа-я]+/g, " ").trim();
  };
  const perSource = new Map();
  for (const list of lists) {
    for (const c of list) perSource.set(c.source, (perSource.get(c.source) || 0) + 1);
  }

  const byNumber = new Map();
  const out = [];
  for (const list of lists) {
    for (const c of list) {
      // том входит в ключ: «глава 1» из тома 1 и тома 2 — разные главы
      const k = c.number != null ? `v:${c.volume ?? 0}|n:${c.number}` : `t:${String(c.title || "").toLowerCase()}`;
      const prev = byNumber.get(k);
      if (prev) {
        // тот же номер из другого источника — одна глава, запоминаем оба
        if (!prev.sources.some((s) => s.source === c.source)) prev.sources.push({ source: c.source, extId: c.id });
        if (!prev.title && c.title) prev.title = c.title;
        continue;
      }
      const copy = { ...c, sources: [{ source: c.source, extId: c.id }] };
      byNumber.set(k, copy);
      out.push(copy);
    }
  }

  // второй проход: разные номера, но одна и та же глава (у источников по одной главе)
  const sigGroups = new Map();
  for (const ch of out) {
    if (perSource.get(ch.source) !== 1) continue;
    const s = sigOf(ch.title);
    if (!s) continue;
    const arr = sigGroups.get(s) || [];
    arr.push(ch);
    sigGroups.set(s, arr);
  }
  for (const [, arr] of sigGroups) {
    if (arr.length < 2) continue;
    const base = arr[0];
    for (const other of arr.slice(1)) {
      for (const s of other.sources) {
        if (!base.sources.some((x) => x.source === s.source)) base.sources.push(s);
      }
      const idx = out.indexOf(other);
      if (idx >= 0) out.splice(idx, 1);
    }
  }

  // у постов без номера в названии (первая часть серии) ставим свободный номер,
  // иначе такая глава уезжает в конец списка
  const used = new Set(out.filter((c) => c.number != null).map((c) => Number(c.number)));
  let next = 1;
  for (const c of out) {
    if (c.number != null) continue;
    while (used.has(next)) next += 1;
    c.number = next;
    c.order = next;
    used.add(next);
  }

  return out.sort((a, b) => {
    const na = a.order ?? a.number ?? Number.MAX_SAFE_INTEGER;
    const nb = b.order ?? b.number ?? Number.MAX_SAFE_INTEGER;
    return na - nb || String(a.title || '').localeCompare(String(b.title || ''));
  });
}

async function apiMangaDetail(id) {
  const parsed = registry.parseId(id);
  if (!parsed) return null;
  const adapter = registry.findAdapter(parsed.source);
  if (!adapter) return null;
  const d = await adapter.detail(parsed.extId);
  if (!d) return null;

  // другие источники с той же работой
    let hitCovers = [];
  let others = [];
  try {
    const key = workKey(d.title);
    const hit = state.merged?.find((w) => w.key === key);
    if (hit) others = hit.sources.map((s) => ({ source: s.source, id: s.extId, url: s.url }));
        // обложки всех источников этой работы — пригодится, если основная битая
        hitCovers = [hit.cover, ...hit.sources.map((s) => s.cover)].filter(Boolean);
  } catch { /* ignore */ }

  return {
    id: `${parsed.source}:${parsed.extId}`,
    title: stripChapterSuffix(d.title) || d.title,
      cover: d.cover || hitCovers[0] || '',
      covers: hitCovers.length ? hitCovers : [d.cover].filter(Boolean),
    author: d.author || '',
    description: d.description || '',
    genres: d.genres || [],
    sources: others,
  };
}

async function apiChapters(id) {
  const parsed = registry.parseId(id);
  if (!parsed) return [];
  const adapter = registry.findAdapter(parsed.source);
  if (!adapter) return [];

  // название работы берём из собранного индекса каталога — без сетевого запроса.
  // Раньше здесь ждали adapter.detail() (у hchan до 4.5 с), и запрос уходил в 502 через туннель.
  const entry = state.merged?.find((w) => w.sources.some((s) => s.source === parsed.source && s.extId === parsed.extId));
  let workTitle = entry && entry.title;
  if (!workTitle) {
    const seed = await withTimeout(adapter.detail(parsed.extId), 1500, 'detail').catch(() => null);
    workTitle = (seed && (seed.work || seed.title)) || null;
  }
  if (!workTitle) {
    return adapter.chapters(parsed.extId).catch(() => []);
  }
  return mergedChapters(workTitle, { source: parsed.source, extId: parsed.extId });
}

async function apiPages(id) {
  const parsed = registry.parseId(id);
  if (!parsed) return null;
  const adapter = registry.findAdapter(parsed.source);
  if (!adapter) return null;
  const res = await adapter.pages(parsed.extId).catch(() => null);
  if (!res) return null;

  // соседние главы считаем по объединённому списку, чтобы листать сквозь источники
  let prevChapterId = res.prevChapterId ? `${parsed.source}:${res.prevChapterId}` : null;
  let nextChapterId = res.nextChapterId ? `${parsed.source}:${res.nextChapterId}` : null;
  try {
    const seed = await adapter.detail(parsed.extId);
    if (seed) {
    const list = await mergedChapters(seed.work || seed.title, { source: parsed.source, extId: parsed.extId });
      const idx = list.findIndex((c) => c.id === id);
      if (idx > 0) prevChapterId = list[idx - 1].id;
      if (idx >= 0 && idx < list.length - 1) nextChapterId = list[idx + 1].id;
    }
  } catch { /* оставляем как есть */ }

  return { pages: res.pages || [], prevChapterId, nextChapterId };
}

/** Фоновый прогрев: разбираем часть работ, чтобы собрать теги, которых нет в sitemap. */
async function warmTags(limit = 200) {
  const works = registry.state.merged || [];
  const chunk = 6;
  let done = 0;
  for (let i = 0; i < works.length && done < limit; i += chunk) {
    const slice = works.slice(i, i + chunk);
    await Promise.all(slice.map(async (w) => {
      const parsed = registry.parseId(`${w.primary.source}:${w.primary.extId}`);
      if (!parsed) return;
      const a = registry.findAdapter(parsed.source);
      if (a) await a.detail(parsed.extId).catch(() => null);
      done += 1;
    }));
  }
  registry.invalidateTagCache();
  const list = await registry.tagsList();
  console.log(`[tags] прогрев: разобрано ${done} работ, тегов ${list.length}`);
}
/** Примитивный лимит запросов на IP, чтобы публичный URL не превращался в открытый прокси. */
const rateHits = new Map();
function clientIp(req) {
  // за туннелем все запросы приходят с 127.0.0.1, поэтому реальный IP берём из XFF
  if (process.env.MM_TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const limit = Number(process.env.MM_RATE_LIMIT || 240);
  const now = Date.now();
  let rec = rateHits.get(ip);
  if (!rec || now - rec.t > 60e3) { rec = { t: now, n: 0 }; rateHits.set(ip, rec); }
  rec.n += 1;
  if (rateHits.size > 5000) rateHits.clear();
  return rec.n > limit;
}
/**
 * Страницы каталога «без дыр»: часть карточек отбрасывается при обогащении (нет глав,
 * источник не ответил), поэтому нарезать список до фильтрации нельзя — страница тощала
 * до 17 из 20. Здесь курсор идёт по общему списку и добирает карточки до полной страницы.
 */
/**
 * Локальный индекс «тег → работы»: наполняется жанрами при обогащении карточек.
 * Позволяет фильтровать по тегу в памяти, не обходя сайты (это было до 5 с и 502 через туннель).
 */

/** Держим кэш в разумных пределах: Map хранит порядок вставки, старые записи уходят первыми. */
function capMap(map, max) {
  while (map.size > max) {
    const k = map.keys().next().value;
    map.delete(k);
  }
}
/** Ключ поиска: регистр, ё→е, только буквы и цифры. Считается один раз на работу. */
const searchKeys = new Map();
function searchKey(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, ' ').trim();
}

/** Поиск по названию среди всех работ каталога (без сети). */
function searchWorks(query, sort, page, perPage) {
  const q = searchKey(query);
  if (!q) return [];
  const raw = registry.listRaw(sort);
  if (!raw) return null;
  if (searchKeys.size !== raw.length) {
    searchKeys.clear();
    for (const w of raw) searchKeys.set(w, searchKey(w.title));
  }
  const words = q.split(' ').filter(Boolean);
  const hits = [];
  for (const w of raw) {
    const k = searchKeys.get(w) || '';
    if (!k) continue;
    if (words.every((word) => k.includes(word))) hits.push(w);
  }
  const start = (page - 1) * perPage;
  return hits.slice(start, start + perPage).map((w) => ({
    id: `${w.primary.source}:${w.primary.extId}`,
    title: w.title,
    cover: w.cover,
    covers: w.covers || [w.cover].filter(Boolean),
    author: '',
    genres: [],
    sources: w.sources.map((s) => ({ source: s.source, id: s.extId, url: s.url })),
  }));
}
const cleanCursors = new Map();
const CLEAN_CHUNK = 40;

async function cleanPage(sort, sourceId, page, perPage, prefetch = false) {
  const raw = registry.listRaw(sort);
  if (!raw) return null;

  const key = `${sort}|${sourceId || ""}`;
  let cur = cleanCursors.get(key);
  // список пересобрали — курсор недействителен
  if (!cur || cur.rawLen !== raw.length) {
    cur = {
      rawLen: raw.length,
      all: sourceId ? raw.filter((w) => w.sources.some((s) => s.source === sourceId)) : raw,
      idx: 0,
      items: [],
      done: false,
    };
    cleanCursors.set(key, cur);
  }

  // Глубокие страницы (раньше 400-й работы в списке) отдаём напрямую из каталога:
  // обогащение каждой карточки — сетевой запрос, и страница 120 ждала бы минутами.
  const ENRICH_LIMIT = Number(process.env.MM_ENRICH_PAGES || 20) * perPage;

  const need = page * perPage;
  let guard = 0;
  while (cur.items.length < need && !cur.done && guard++ < 80) {
    const slice = cur.all.slice(cur.idx, cur.idx + CLEAN_CHUNK);
    if (!slice.length) { cur.done = true; break; }
    cur.idx += slice.length;

    const mapped = slice.map((w) => ({
      id: `${w.primary.source}:${w.primary.extId}`,
      title: w.title,
      cover: w.cover,
      covers: w.covers || [w.cover].filter(Boolean),
      author: '',
      genres: [],
      sources: w.sources.map((s) => ({ source: s.source, id: s.extId, url: s.url })),
    }));
    const plain = (page - 1) * perPage >= ENRICH_LIMIT;
    if (!plain) {
      await enrichWorks(mapped, 1200);
      for (const it of mapped) if (!it.drop) cur.items.push(it);
    } else {
      for (const it of mapped) cur.items.push(it); // данные каталога достаточны для карточки
    }
  }

  // готовим следующую страницу заранее, чтобы «Показать ещё» открывалось мгновенно
  if (!prefetch && !cur.done) {
    setTimeout(() => { cleanPage(sort, sourceId, page + 1, perPage, true).catch(() => {}); }, 40);
  }

  const start = (page - 1) * perPage;
  return cur.items.slice(start, start + perPage);
}
/**
 * Прокси картинок: /img?u=<url>. Нужен для офлайн-скачивания (чужой CDN не даёт читать
 * байты из браузера) и заодно кэширует обложки на диске.
 * Разрешены только известные хосты источников — иначе это превратилось бы в открытый прокси.
 */
const IMG_HOSTS = [
  'multi-manga.com', 'nude-moon.pro', 'cfz.one', 'cfru.me', 'imgschan.xyz',
  'desu.uno', 'zakura.su', 'sexbase.org', 'manga-shi.org', 'h-chan.me', 'qawa.org',
];
const IMG_DIR = path.join(registry.CACHE_DIR, 'img');

function imgAllowed(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    return IMG_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));
  } catch { return false; }
}

async function serveImage(res, rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!imgAllowed(u)) return json(res, 403, { error: 'host not allowed' });

  const hash = crypto.createHash('sha1').update(u).digest('hex');
  const file = path.join(IMG_DIR, hash);
  const metaFile = file + '.json';

  let buf = null;
  let type = 'image/jpeg';
  try {
    buf = await fs.promises.readFile(file);
    const meta = JSON.parse(await fs.promises.readFile(metaFile, 'utf8'));
    type = meta.type || type;
  } catch { buf = null; }

  if (!buf) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res2 = await fetch(u, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL(u).origin + '/', 'Accept': 'image/*' },
      });
      if (!res2.ok) return json(res, 502, { error: 'upstream ' + res2.status });
      const ab = await res2.arrayBuffer();
      if (ab.byteLength > 25 * 1024 * 1024) return json(res, 413, { error: 'too large' });
      buf = Buffer.from(ab);
      type = res2.headers.get('content-type') || 'image/jpeg';
      await fs.promises.mkdir(IMG_DIR, { recursive: true }).catch(() => {});
      fs.promises.writeFile(file, buf).catch(() => {});
      fs.promises.writeFile(metaFile, JSON.stringify({ type, at: Date.now() })).catch(() => {});
    } catch {
      return json(res, 504, { error: 'image timeout' });
    } finally {
      clearTimeout(timer);
    }
  }

  return send(res, 200, buf, type, { 'Cache-Control': 'public, max-age=2592000, immutable' });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (route !== '/health' && route !== '/img' && rateLimited(req)) {
    return json(res, 429, { error: 'too many requests', retryAfter: 60 });
  }
  const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
  const tags = url.searchParams.getAll('tag').map((t) => t.trim()).filter(Boolean);
  const query = String(url.searchParams.get('q') || '').trim();
  const source = url.searchParams.get('source');
  const sortRaw = String(url.searchParams.get('sort') || 'new').toLowerCase();
  const sort = ['new', 'old', 'az', 'za'].includes(sortRaw) ? sortRaw : 'new';

  try {
    if (route === '/') return json(res, 200, {
      ok: true,
      crawling: state.crawling,
      refreshing: state.refreshing,
      mergedWorks: state.merged?.length ?? null,
      sources: state.sources.map((s) => ({ id: s.id, ready: s.ready, posts: s.posts, works: s.works, scanned: s.scanned, builtAt: s.builtAt, stale: s.stale, error: s.error })),
      endpoints: ['/api/manga?page=1', '/api/manga?tag=<slug>', '/api/tags', '/api/sources', '/api/random', '/api/manga/<src:id>', '/api/manga/<src:id>/chapters', '/api/chapter/<src:id>/pages'],
      demo: '/demo',
    });

    if (route === '/img') return serveImage(res, url.searchParams.get('u'));

    if (route === '/health') return json(res, 200, {
      ok: !state.crawling,
      crawling: state.crawling,
      refreshing: state.refreshing,
      mergedWorks: state.merged?.length ?? null,
      sources: state.sources.map((s) => ({ id: s.id, ready: s.ready, posts: s.posts, works: s.works, scanned: s.scanned, builtAt: s.builtAt, stale: s.stale, error: s.error })),
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1048576),
    });

    if (route === '/MangaReader.apk') {
      const apk = await fs.promises.readFile(path.join(__dirname, 'MangaReader.apk')).catch(() => null);
      if (!apk) return json(res, 404, { error: 'apk not found' });
      return send(res, 200, apk, 'application/vnd.android.package-archive', {
        'Content-Disposition': 'attachment; filename="MangaReader.apk"',
        'Cache-Control': 'public, max-age=300',
      });
    }
    if (route === '/api/sources') return json(res, 200, state.sources.map((s) => ({
      id: s.id, name: s.name, base: s.base, ready: s.ready, posts: s.posts, works: s.works, scanned: s.scanned, builtAt: s.builtAt, stale: s.stale, error: s.error,
    })));

    if (route === '/demo' || route === '/demo.html') {
      const html = await fs.promises.readFile(path.join(__dirname, 'demo.html'));
      return send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }

    if (route === '/api/random') {
      // Случайная работа: без запроса страницы (страница N — это до N*20 обогащений,
      // из-за чего «Случайно» на публичном адресе падало 502)
      const raw = registry.listRaw(sort);
      if (!raw || !raw.length) return json(res, 503, { error: 'catalog not ready', crawling: state.crawling });
      let pool = raw;
      if (source) pool = pool.filter((w) => w.sources.some((s) => s.source === source));
      if (!pool.length) return json(res, 404, { error: 'nothing found' });
      const w = pool[Math.floor(Math.random() * pool.length)];
      return json(res, 200, { id: `${w.primary.source}:${w.primary.extId}`, title: w.title, cover: w.cover });
    }
    if (route === '/api/manga') {
      if (query) {
        const found = searchWorks(query, sort, page, CONFIG.PER_PAGE);
        if (!found) return json(res, 503, { error: 'catalog not ready', crawling: state.crawling });
        return json(res, 200, found);
      }
      if (tags.length) {
        const tagged = await taggedList(tags, page, CONFIG.PER_PAGE, sort);
        const enriched = await enrichWorks(tagged);
        return json(res, 200, enriched.filter((it) => !it.drop));
      }
      const list = await cleanPage(sort, source, page, CONFIG.PER_PAGE);
      if (!list) return json(res, 503, { error: 'catalog not ready', crawling: state.crawling });
      return json(res, 200, list);
    }

    if (route === '/api/tags') return json(res, 200, await registry.tags(page, 500, source));

    let m = route.match(/^\/api\/manga\/([^/]+)\/chapters$/);
    if (m) {
      const parsed = registry.parseId(m[1]);
      if (!parsed) return json(res, 400, { error: 'bad manga id' });
      return json(res, 200, await apiChapters(m[1]));
    }

    m = route.match(/^\/api\/manga\/([^/]+)$/);
    if (m) {
      const detail = await apiMangaDetail(m[1]);
      if (!detail) return json(res, 404, { error: 'manga not found' });
      return json(res, 200, detail);
    }

    m = route.match(/^\/api\/chapter\/([^/]+)\/pages$/);
    if (m) {
      const data = await apiPages(m[1]);
      if (!data) return json(res, 404, { error: 'chapter not found' });
      return json(res, 200, data);
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[api]', req.method, req.url, e.message);
    return json(res, 502, { error: 'upstream error', detail: e.message });
  }
});

// телефон на мобильном интернете: держим соединение живым, а не пересоздаём на каждый запрос
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(CONFIG.PORT, () => {
  console.log(`MangaReader API on http://localhost:${CONFIG.PORT}`);
  console.log('[catalog] источники:', registry.adapters.map((a) => a.id).join(', '));
  registry.warm()
    .then(() => { if (!process.env.MM_NO_TAG_WARM) warmTags(Number(process.env.MM_TAG_WARM || 200)); })
    .catch((e) => console.error('[catalog] warm failed:', e.message));
});
// Аккуратное завершение: на хостинге приходит SIGTERM, кэши тегов должны успеть записаться.
function shutdown(signal) {
  console.log('[server] завершение по', signal);
  server.close(() => {
    try { tagsIndex.flush(); } catch { /* необязательно */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
