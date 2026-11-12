'use strict';
/**
 * Источник: manga-shi.org — SSR-сайт, всё лежит в HTML.
 *
 *   каталог:  /manga-genre/18/?page=N
 *   карточка: /manga/<slug>/
 *   главы:    /manga/<slug>/chapters/?page=N   → ссылки /manga/<slug>/glava-N/
 *   страницы: страница главы, картинки /media/chapters/*.jpg
 */
const { fetchText, stripTags, absUrl, trimCache } = require('./http');
const tagsIndex = require('./tags');

const BASE = 'https://manga-shi.org';
// каталог строго по тегу «хентай» (tag-f3e59b6b)
const CATALOG = '/catalog/?tag=tag-f3e59b6b';

const cache = new Map();
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  cache.set(key, { exp: Date.now() + ttl, value: v });
  trimCache(cache, 400);
  return v;
};

async function catalogPage(page) {
  return cached(`p:${page}`, 10 * 60e3, async () => {
    const html = await fetchText(`${BASE}${CATALOG}&page=${page}`).catch(() => '');
    const out = [];
    const re = /<a href="(\/manga\/[^"\/]+\/)"[\s\S]{0,1200}?<img[^>]*src="([^"]+)"[^>]*(?:alt="Обложка манги ([^"]*)"|title="([^"]*)")/g;
    let m;
    while ((m = re.exec(html))) {
      const slug = m[1].replace(/^\/manga\//, '').replace(/\/$/, '');
      const title = stripTags(m[3] || m[4] || slug);
      if (!slug || !title) continue;
      if (out.some((x) => x.extId === slug)) continue;
      out.push({ extId: slug, title, url: BASE + m[1], cover: absUrl(BASE, m[2]) });
    }
    return out;
  });
}

async function detail(slug) {
  return cached(`d:${slug}`, 30 * 60e3, async () => {
    const html = await fetchText(`${BASE}/manga/${slug}/`).catch(() => '');
    if (!html) return null;
    const title = stripTags((html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/) || [])[1] || '');
    if (!title) return null;
    const cover = (html.match(/<img[^>]*(?:class="[^"]*manga-cover[^"]*"|alt="Обложка манги [^"]*")[^>]*src="([^"]+)"/) || [])[1]
      || (html.match(/<img[^>]*src="(\/media\/covers\/[^"]+)"/) || [])[1];
    const genres = [];
    for (const g of html.matchAll(/href="\/manga-genre\/(\d+)\/"[^>]*>([^<]+)</g)) {
      const name = stripTags(g[2]);
      if (name && name !== '#18+' && !genres.includes(name)) genres.push(name);
    }
    const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/) || html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]{0,600}?)<\/div>/);
    return {
      extId: slug,
      title,
      url: `${BASE}/manga/${slug}/`,
      cover: cover ? absUrl(BASE, cover) : null,
      author: '',
      genres,
      description: descMatch ? stripTags(descMatch[1]).slice(0, 800) : '',
      date: null,
      chapterNumber: null,
      chapterTitle: null,
    };
  });
}

async function chapters(slug) {
  return cached(`ch:${slug}`, 20 * 60e3, async () => {
    const seen = new Map();
    for (let page = 1; page <= 20; page++) {
      const html = await fetchText(`${BASE}/manga/${slug}/chapters/?page=${page}`).catch(() => '');
      if (!html) break;
      let added = 0;
      // ссылки бывают двух видов: /manga/<slug>/glava-N/ и /manga/<slug>/tom-1/glava-N/
      for (const m of html.matchAll(new RegExp(`href="/manga/${slug}/(?:tom-(\\d+)/)?glava-(\\d+)/"[^>]*>([\\s\\S]{0,2000}?)</a>`, 'g'))) {
        const volume = m[1] ? Number(m[1]) : null;
        const num = Number(m[2]);
        const key = `${volume ?? 0}-${num}`;
        if (!seen.has(key)) {
          seen.set(key, {
            extId: `${slug}~${volume ? `tom-${volume}~` : ''}glava-${num}`,
            number: num,
        volume: volume || null,
        order: (volume || 0) * 1000 + num,
            title: `Глава ${num}${volume ? ` (том ${volume})` : ''}`,
            date: null,
          });
          added++;
        }
      }
      if (!added) break;
    }
    return [...seen.values()].sort((a, b) => a.number - b.number);
  });
}

async function pages(chapterExtId) {
  return cached(`pg:${chapterExtId}`, 60 * 60e3, async () => {
    const pagePath = String(chapterExtId).split('~').join('/');
    const html = await fetchText(`${BASE}/manga/${pagePath}/`).catch(() => '');
    if (!html) return null;
    const out = [];
    for (const m of html.matchAll(/<img[^>]*(?:data-src|src)="([^"]*\/media\/chapters\/[^"]+\.(?:jpg|jpeg|png|webp))"/g)) {
      const url = absUrl(BASE, m[1]);
      if (!out.includes(url)) out.push(url);
    }
    if (!out.length) return null;
    return { pages: out, prevChapterId: null, nextChapterId: null };
  });
}

async function tags() { return []; }

async function tagPage() { return []; }

module.exports = {
  id: 'mangashi', name: 'manga-shi.org', base: BASE, maxPages: 10,
  catalogPage, detail, chapters, pages, tags, tagPage,
};
