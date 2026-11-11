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
const CYR = /[а-яё]/i;

/** Достаёт самое длинное русское название из скобок (в т.ч. вложенных). */
function russianFromParens(raw) {
  const found = [];
  let s = String(raw);
  for (let pass = 0; pass < 5; pass++) {
    const m = [...s.matchAll(/\(([^()]+)\)/g)];
    if (!m.length) break;
    for (const g of m) found.push(g[1].trim());
    s = s.replace(/\(([^()]+)\)/g, ' ');
  }
  // «(0-3 главы)» — это диапазон глав, а не название
  const ok = found.filter((x) => CYR.test(x) && !/[a-z]/i.test(x) && x.length > 2 && !isChapterRange(x));
  ok.sort((a, b) => b.length - a.length);
  return ok[0] || null;
}

/** «0-3 главы», … — диапазон глав, а не название (объявлена до использования). */
function isChapterRange(s) {
  const x = String(s || '').trim();
  if (!x) return true;
  if (/^(?:том|vol|volume)\s*[\d.,\-–—\s]+$/i.test(x)) return true;
  if (/^(?:глава|главы|главу|часть|chapter|ch)\s*[\d.,\-–—\s]+$/i.test(x)) return true;
  // начинается с чисел/разделителей, дальше слово про главы — и, возможно, приписка («+бонус»)
  if (/^[\d\s,.+\-–—/]*(?:главы|глава|глав|глпвы|клава|главу|часть|том[а]?|vol\.?|chapter|ch)(?![а-яё])/i.test(x)) return true;
  // только числа/разделители + слово «главы» и ничего больше
  return /^[\d\s,.+\-–—/]+(?:главы|глава|глав|главу)?$/i.test(x);
}

const displayTitle = (t) => {
  const raw = String(t || '');
  // «(0-3 главы)» — это диапазон глав, а не название: убираем до разбора сегментов
  const cleaned = raw
    .replace(/\(\s*[\d\s,.+\-–—/]*\s*(?:главы|глава|глав|глпвы|клава|том[а]?|vol\.?|chapter)(?![а-яё])[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || raw;
  const base = stripChapterSuffix(cleaned) || cleaned;
  const startsLatin = /^[A-Za-z]/.test(base);
  // делим «Оригинал / Перевод» и выбрасываем сегменты-диапазоны глав
  const segs = String(base).split(/\s*[/|]\s*/).map((x) => x.trim()).filter((x) => x && !isChapterRange(x));
  const cyrCount = (s) => (s.match(/[а-яё]/gi) || []).length;

  const pickRussian = () => {
    const cyr = segs.filter((s) => CYR.test(s) && !/^[a-z]/i.test(s) && cyrCount(s) >= 3);
    if (!cyr.length) return null;
    cyr.sort((a, b) => cyrCount(b) - cyrCount(a) || b.length - a.length);
    return cyr[0];
  };

  const ruSeg = pickRussian();
  // начинается с латиницы или первый сегмент оказался диапазоном — берём русский вариант
  if (ruSeg && (startsLatin || segs.length > 1)) return ruSeg;
  // название уже русское — оставляем русскую часть, латинский «хвост перевода» отрезаем
  if (CYR.test(base) && !startsLatin) {
    if (segs.length > 1 && ruSeg) return ruSeg;
    return segs[0] || base;
  }
  if (ruSeg) return ruSeg;
  const ru = russianFromParens(raw);
  if (ru) return ru;
  return segs[0] || base;
};

// каталог кэша: по умолчанию рядом с проектом, но на хостинге задаётся через MM_CACHE_DIR
const CACHE_DIR = process.env.MM_CACHE_DIR || path.join(__dirname, '..', 'cache');

const adapters = [
  require('./mm'),
  require('./nudemoon'),
  require('./sexbase'),
  require('./mangashi'),
  require('./zakura'),
  require('./desu'),
  require('./hchan'),
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
    // если источник в этот раз отдал заметно меньше, чем раньше (сайт лежит или режет),
    // не затираем хороший кэш маленьким
    try {
      const prev = JSON.parse(fs.readFileSync(cacheFile(s.id), 'utf8'));
      // порог работает и для маленьких источников (mangashi 195, zakura 236): раньше они затирались нулём
      if (prev.items && prev.items.length >= 50 && s.items.length < prev.items.length * 0.5) {
        console.error(`[${s.id}] каталог пришёл меньше обычного (${s.items.length} < ${prev.items.length}) — оставляю прежний`);
        return;
      }
    } catch { /* прежнего кэша нет — сохраняем как есть */ }
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
      g = { key, title: displayTitle(item.title), raw: item.title, cover: item.cover, sources: [], _min: Infinity, count: 0, primary: null };
      byKey.set(key, g);
    }
    g.count += 1;
    // в sources — только одна запись на источник (первая по возрастанию id), иначе
    // в карточке окажутся все главы этой же работы
    const num = Number(item.extId);
    const cmp = Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER; // у нецифровых id (например uuid) — в конец
    if (!g.primary || cmp < g._min) {
      g._min = cmp;
      g.primary = { source: s.id, extId: item.extId, url: item.url };
      g.cover = item.cover || g.cover;
      g.title = displayTitle(item.title);
      g.raw = item.title;
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
        const item = { key: g.key, title: g.title, raw: g.raw || g.title, cover: g.cover, primary: g.sources[0], sources: [...g.sources] };
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
  // одинаковые подписи у разных работ (например, общий русский подзаголовок) разводим
  // полным названием, иначе в каталоге выглядят как дубликаты
  const seenTitle = new Map();
  for (const it of order) {
    const t = (it.title || '').toLowerCase();
    seenTitle.set(t, (seenTitle.get(t) || 0) + 1);
  }
  for (const it of order) {
    if (seenTitle.get((it.title || '').toLowerCase()) > 1 && it.raw && it.raw !== it.title) {
      it.title = stripTags(it.raw);
    }
  }

  state.merged = order;
  state.sorted = {};
  state.sortKeys = null;
  state.mergedAt = Date.now();
  state.siblings = buildSiblingIndex();
}

/** Номер части из хвоста заголовка: «Мама это должна быть ты 5» → 5. */
function partNumber(title) {
  const t = String(title);
  const m = t.match(/(?:глава|главы|главу|часть|том|chapter|part|vol)\s*[.\-–—:№#]?\s*(\d{1,3}(?:[.,]\d+)?)/i) // «глава 5», «часть 2»
    || t.match(/(?:№|#)\s*(\d{1,3}(?:[.,]\d+)?)/)              // «#2», «№3»
    || t.match(/\s(\d{1,3}(?:[.,]\d+)?)\s*[-–—:|]\s*\S/)       // «3 - Глаза Люси»
    || t.match(/(?:№|#)?\s*(\d{1,3}(?:[.,]\d+)?)\s*$/);        // «… ты 5»
  return m ? Number(m[1].replace(",", ".")) : null;
}
/**
 * Индекс «серия → все посты источника». Нужен там, где один пост = одна часть или глава:
 * карточка в каталоге одна, а главы собираются из этого индекса без запросов к сайту.
 */
function buildSiblingIndex() {
  const index = new Map();
  for (const s of state.sources) {
    if (!s.items) continue;
    for (const item of s.items) {
      const key = workKey(item.title);
      if (!key) continue;
      const entry = { extId: item.extId, title: item.title, url: item.url, part: partNumber(item.title) };
      // два ключа: сырое название и «красивое» (displayTitle). Иначе главы ищутся
      // по отображаемому названию и серия не находится.
      const aliases = new Set([key, workKey(displayTitle(item.title))]);
      for (const alias of aliases) {
        if (!alias) continue;
        const k = s.id + "|" + alias;
        let arr = index.get(k);
        if (!arr) { arr = []; index.set(k, arr); }
        if (!arr.some((x) => x.extId === entry.extId)) arr.push(entry);
      }
    }
  }
  return index;
}

/** Все посты источника с тем же названием серии (по ключу работы). */
function siblings(source, title) {
  const key = workKey(title);
  if (!key || !state.siblings) return [];
  return state.siblings.get(source + '|' + key) || [];
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
      if (!list.length) { misses += 1; if (misses >= 5) break; continue; }
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

/** Список под нужную сортировку (кэшируется, пока не пересобран каталог). */
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

/**
 * Ключ для сортировки по алфавиту.
 * Проблемы старого варианта: названия с латиницей («Soft and Slim / Мягкая и стройная»),
 * с префиксом автора («[Eugenio Sicomoro] Холодный свет») и с ведущей пунктуацией
 * («¡Quiero…», «?Моя призрачная…») вставали в начало или в конец списка не по алфавиту.
 */
function sortKey(title) {
  let t = String(title || '');
  // «[Автор] Название» → «Название»
  t = t.replace(/^\s*(?:[[(][^\])]{0,80}[\])]\s*)+/, '');
  // выбираем самый «русский» фрагмент из «Оригинал / Перевод»
  const parts = t.split(/\s+[/|]\s+/);
  if (parts.length > 1) {
    const cyrCount = (s) => (s.match(/[а-яё]/gi) || []).length;
    parts.sort((a, b) => cyrCount(b) - cyrCount(a));
    t = parts[0];
  }
  t = t.toLowerCase().replace(/ё/g, 'е')
    .replace(/^[^0-9a-zа-я]+/, '')
    .replace(/[^0-9a-zа-я]+/g, ' ')
    .trim();
  // порядок групп: цифры → кириллица → латиница (обратная сортировка читается наоборот)
  const group = /^[0-9]/.test(t) ? '0' : /^[а-я]/.test(t) ? '1' : '2';
  return group + t;
}

function sortedList(sort) {
  if (!state.sorted) state.sorted = {};
  if (state.sorted[sort]) return state.sorted[sort];
  let list = state.merged;
  if (sort === 'old') list = [...list].reverse();
  else if (sort === 'az' || sort === 'za') {
    if (!state.sortKeys) {
      state.sortKeys = new Map();
      for (const w of state.merged) state.sortKeys.set(w, sortKey(w.title));
    }
    list = [...list].sort((a, b) => collator.compare(state.sortKeys.get(a) || '', state.sortKeys.get(b) || ''));
    if (sort === 'za') list = [...list].reverse();
  }
  state.sorted[sort] = list;
  return list;
}

function listPage(page, perPage, sourceId, sort = 'new') {
  if (!state.merged) return null;
  let list = sortedList(sort);
  if (sourceId) list = list.filter((w) => w.sources.some((s) => s.source === sourceId));
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

/**
 * Быстрый вариант slugFor: только по локальному индексу тегов, без сетевых запросов.
 * Нужен в фильтре каталога — полный slugFor тянет списки тегов у всех источников (до 20 с).
 */
function slugForFast(sourceId, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const vKey = tagKey(raw);
  for (const t of tagsIndex.all()) {
    if (t.source !== sourceId) continue;
    if (t.slug === raw || tagKey(t.name) === vKey || tagKey(t.slug) === vKey) return t.slug;
  }
  return null;
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

module.exports = {
  siblings, displayTitle, sortKey, partNumber, isChapterRange, listRaw: sortedList, CACHE_DIR, slugForFast, state, adapters, warm, parseId, findAdapter, listPage, tags, tagsList, slugFor, invalidateTagCache };
