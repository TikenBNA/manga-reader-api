'use strict';
/**
 * Источник: sexbase.org — только раздел манги (видео игнорируем).
 * У сайта есть открытый JSON API:
 *   GET /api/v2/manga?limit=100&offset=N        — каталог (total есть в ответе)
 *   GET /api/v2/manga/<id>                      — карточка (titles, tags, cover)
 *   GET /api/v2/manga/<id>/pages                — все страницы одной работы
 *   GET /api/v2/manga?tag=<название тега>       — фильтр по тегу (русское название)
 * Одна запись = одна работа целиком (без разбивки на главы), читается сразу.
 */
const { fetchJson, stripTags, stripChapterSuffix, trimCache } = require('./http');
const tagsIndex = require('./tags');

const BASE = 'https://sexbase.org';
const API = `${BASE}/api/v2`;
const LIMIT = 100;
const LANG = process.env.MM_SEXBASE_LANG || 'ru'; // берём только русскоязычные работы

const cache = new Map();
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  cache.set(key, { exp: Date.now() + ttl, value: v });
  trimCache(cache, 800);
  return v;
};

/** Название на русском; null — если после отсечения нумерации главы русского не осталось. */
function titleOf(m) {
  const t = m.titles || {};
  const raw = (t.russian || t.pretty || '').trim();
  if (!raw) return null;
  const base = stripChapterSuffix(raw);
  if (!/[а-яё]/i.test(base)) return null;   // японские/английские названия не берём
  return raw;
}

async function catalogPage(page) {
  const offset = (page - 1) * LIMIT;
  return cached(`p:${page}`, 5 * 60e3, async () => {
    const data = await fetchJson(`${API}/manga?limit=${LIMIT}&offset=${offset}&lang=${LANG}`).catch(() => ({ manga: [] }));
    return (data.manga || []).map((m) => {
      const title = titleOf(m);
      if (!title) return null;   // не русская — пропускаем
      const slug = m.slug || m.media_id || m.id;
      return {
        extId: String(m.id),
        title,
        url: `${BASE}/ru/manga/${slug}_${m.id}`,
        cover: m.thumbnail || m.cover || null,
      };
    }).filter(Boolean);
  });
}

async function detail(extId) {
  return cached(`d:${extId}`, 30 * 60e3, async () => {
    const d = await fetchJson(`${API}/manga/${extId}`).catch(() => null);
    if (!d || !d.id) return null;
    const genres = [];
    for (const t of d.tags || []) {
      const name = stripTags(t.name || '');
      if (!name) continue;
      genres.push(name);
      // slug для фильтра — само название: API понимает ?tag=<название>
      tagsIndex.note('sexbase', name, name);
    }
    const slug = d.slug || d.media_id || d.id;
    return {
      extId: String(extId),
      title: titleOf(d) || ((d.titles && (d.titles.russian || d.titles.pretty)) || String(extId)).trim(),
      url: `${BASE}/ru/manga/${slug}_${d.id}`,
      cover: d.cover || d.thumbnail || null,
      author: '',
      genres,
      description: '',
      date: (d.created_at || '').replace('T', ' ').slice(0, 19) || null,
      chapterNumber: d.chapter_number ?? null,
      chapterTitle: d.chapter_title || null,
    };
  });
}

async function chapters(extId) {
  const d = await detail(extId);
  if (!d) return [];
  return [{
    extId: String(extId),
    number: d.chapterNumber ?? 1,
    title: d.chapterTitle || d.title,
    date: d.date,
  }];
}

async function pages(extId) {
  return cached(`pg:${extId}`, 60 * 60e3, async () => {
    const data = await fetchJson(`${API}/manga/${extId}/pages`).catch(() => null);
    if (!data || !Array.isArray(data.pages) || !data.pages.length) return null;
    return {
      pages: data.pages.map((p) => p.url).filter(Boolean),
      prevChapterId: null,
      nextChapterId: null,
    };
  });
}

/** Список тегов у источника не отдаётся — наполняем из карточек (tagsIndex). */
async function tags() { return []; }

async function tagPage(tag, page) {
  const offset = (page - 1) * LIMIT;
  return cached(`t:${tag}:${page}`, 5 * 60e3, async () => {
    const data = await fetchJson(
      `${API}/manga?tag=${encodeURIComponent(tag)}&limit=${LIMIT}&offset=${offset}&lang=${LANG}`,
    ).catch(() => ({ manga: [] }));
    return (data.manga || []).map((m) => ({
      extId: String(m.id),
      title: titleOf(m),
      url: `${BASE}/ru/manga/${m.slug || m.media_id || m.id}_${m.id}`,
      cover: m.thumbnail || m.cover || null,
    }));
  });
}

module.exports = {
  id: 'sexbase', name: 'sexbase.org', base: BASE,
  maxPages: Number(process.env.MM_SEXBASE_PAGES || 60),
  catalogPage, detail, chapters, pages, tags, tagPage,
};
