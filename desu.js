'use strict';
/**
 * Источник: desu.uno (Desu.Me) — раздел манги, фильтр по жанру «Хентай» (genres=59-Hentai).
 *
 *   каталог:  /manga/?genres=59-Hentai&page=N   (HTML)
 *   карточка: /api/manga/<id>                   (JSON)
 *   главы:    /api/manga/<id>/chapters          (JSON)
 *   страницы: /api/manga/<id>/chapters/<chapId> (JSON, pages[].url)
 */
const { fetchJson, fetchText, stripTags, absUrl } = require('./http');
const tagsIndex = require('./tags');

const BASE = 'https://desu.uno';
const CATALOG = '/manga/?genres=59-Hentai';

const cache = new Map();
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  if (v != null) cache.set(key, { exp: Date.now() + ttl, value: v }); // неудачу не кэшируем
  return v;
};

async function catalogPage(page) {
  return cached(`p:${page}`, 10 * 60e3, async () => {
    const url = page <= 1 ? `${BASE}${CATALOG}` : `${BASE}${CATALOG}&page=${page}`;
    const html = await fetchText(url).catch(() => '');
    const out = [];
    for (const m of html.matchAll(/<a href="manga\/([^"]+?)\.(\d+)\/"[^>]*class="avatar[^"]*"[\s\S]{0,600}?<span class="img"[^>]*background-image: url\('([^']+)'\)[^>]*title="([^"]*)"/g)) {
      const extId = m[2];
      const title = stripTags(m[4]);
      if (!extId || !title || out.some((x) => x.extId === extId)) continue;
      out.push({ extId, title, url: `${BASE}/manga/${m[1]}.${m[2]}/`, cover: m[3] });
    }
    return out;
  });
}

async function detail(extId) {
  return cached(`d:${extId}`, 30 * 60e3, async () => {
    const data = await fetchJson(`${BASE}/api/manga/${extId}`).catch(() => null);
    const m = data?.manga;
    if (!m) return null;
    const genres = [];
    for (const g of m.genres || []) {
      const name = stripTags(g.russian || g.name || '');
      if (!name) continue;
      genres.push(name);
      tagsIndex.note('desu', String(g.id || name), name);
    }
    // берём только тайтлы, у которых в жанрах есть «Хентай»
    if (!genres.some((g) => /хентай/i.test(g))) return null;

    return {
      extId,
      title: stripTags(m.russian || m.name || ''),
      url: `${BASE}${m.view_url || `/manga/${extId}/`}`,
      cover: m.cover?.snippet || m.cover?.preview || null,
      author: (m.authors || []).map((a) => a.name).filter(Boolean).join(', '),
      genres,
      description: stripTags(m.description || '').slice(0, 1000),
      date: m.aired_on ? new Date(m.aired_on * 1000).toISOString().slice(0, 19).replace('T', ' ') : null,
      chapterNumber: null,
      chapterTitle: null,
    };
  });
}

async function chapters(extId) {
  return cached(`ch:${extId}`, 10 * 60e3, async () => {
    const data = await fetchJson(`${BASE}/api/manga/${extId}/chapters`).catch(() => null);
    if (!data || !Array.isArray(data.chapters)) return [];
    return data.chapters
      .map((c) => {
        const volume = Number(c.volume) || 0;
        const number = Number(String(c.number || '').replace(',', '.')) || 0;
        return {
          extId: `${extId}~${c.id}`,
          number,
          volume: volume || null,
          order: volume * 1000 + number,
          title: `Глава ${c.number}${volume ? ` (том ${volume})` : ''}${c.title ? ' — ' + c.title : ''}`,
          date: c.publish_date ? new Date(c.publish_date * 1000).toISOString().slice(0, 19).replace('T', ' ') : null,
        };
      })
      .sort((a, b) => a.number - b.number)
      .map((c, i) => ({ ...c, number: c.number || i + 1 }));
  });
}

async function pages(chapterExtId) {
  return cached(`pg:${chapterExtId}`, 30 * 60e3, async () => {
    const [mangaId, chapterId] = String(chapterExtId).split('~');
    if (!mangaId || !chapterId) return null;
    const data = await fetchJson(`${BASE}/api/manga/${mangaId}/chapters/${chapterId}`).catch(() => null);
    const list = (data?.chapter?.pages || []).map((p) => p.url).filter(Boolean);
    if (!list.length) return null;
    return { pages: list, prevChapterId: null, nextChapterId: null };
  });
}

async function tags() { return []; }
async function tagPage() { return []; }

module.exports = {
  id: 'desu', name: 'desu.uno', base: BASE, maxPages: 28,
  catalogPage, detail, chapters, pages, tags, tagPage,
};
