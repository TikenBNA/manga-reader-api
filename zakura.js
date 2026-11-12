'use strict';
/**
 * Источник: zakura.su — DLE, раздел «хентай манга».
 *
 *   каталог:  /hentai-manga/page/N/
 *   пост:     /hentai-manga/<id>-<slug>.html
 *   чтение:   картинка спрятана в спойлере <div id="sp…"> — это одна длинная полоса
 *             (например 800×32800), поэтому вся манга = одна «глава» и одна страница.
 */
const { fetchText, stripTags, absUrl, trimCache } = require('./http');
const tagsIndex = require('./tags');

const BASE = 'https://zakura.su';
const SECTION = '/hentai-manga';

const cache = new Map();
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  cache.set(key, { exp: Date.now() + ttl, value: v });
  trimCache(cache, 400);
  return v;
};

const postId = (extId) => String(extId).replace(/\.html$/, '');

async function catalogPage(page) {
  return cached(`p:${page}`, 10 * 60e3, async () => {
    const url = page <= 1 ? `${BASE}${SECTION}/` : `${BASE}${SECTION}/page/${page}/`;
    const html = await fetchText(url).catch(() => '');
    const out = [];
    for (const m of html.matchAll(/<a href="(https:\/\/zakura\.su\/hentai-manga\/(\d+)-[^"]+\.html)"[^>]*title="([^"]*)"[\s\S]{0,600}?<img[^>]*src="([^"]+)"/g)) {
      const title = stripTags(m[3]);
      const extId = `${m[2]}-${m[1].split('/').pop().replace(/^\d+-/, '')}`;
      if (!title || out.some((x) => x.extId === extId)) continue;
      out.push({ extId, title, url: m[1], cover: absUrl(BASE, m[4]) });
    }
    return out;
  });
}

async function postHtml(extId) {
  return cached(`h:${extId}`, 30 * 60e3, () => fetchText(`${BASE}${SECTION}/${postId(extId)}.html`).catch(() => ''));
}

async function detail(extId) {
  const html = await postHtml(extId);
  if (!html) return null;
  const title = stripTags((html.match(/<h1[^>]*>([\s\S]{0,600}?)<\/h1>/) || [])[1] || '');
  if (!title) return null;
  const cover = (html.match(/<div class="fstory-poster">\s*<img src="([^"]+)"/) || [])[1]
    || (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
  const genres = [];
  for (const g of html.matchAll(/href="https:\/\/zakura\.su\/xfsearch\/rip\/([^"\/]+)\/"[^>]*>([^<]+)</g)) {
    const name = decodeURIComponent(g[1]).replace(/\+/g, ' ');
    if (name && name !== '18+' && !/хентай манга/i.test(name) && !genres.includes(name)) genres.push(name);
    if (name) tagsIndex.note('zakura', name, name);
  }
  const desc = (html.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || '';
  return {
    extId,
    title,
    url: `${BASE}${SECTION}/${postId(extId)}.html`,
    cover: cover ? absUrl(BASE, cover) : null,
    author: '',
    genres,
    description: stripTags(desc).replace(/нажми чтобы читать.*$/i, '').trim().slice(0, 600),
    date: null,
    chapterNumber: 1,
    chapterTitle: title,
  };
}

/** Одна работа = одна длинная полоса-картинка. */
async function chapters(extId) {
  const d = await detail(extId);
  if (!d) return [];
  return [{ extId, number: 1, title: d.title, date: null }];
}

async function pages(extId) {
  return cached(`pg:${extId}`, 60 * 60e3, async () => {
    const html = await postHtml(extId);
    if (!html) return null;
    // картинка внутри спойлера <div id="sp…">
    const spoiler = html.match(/<div id="sp[0-9a-f]+"[^>]*>([\s\S]*?)<div class="clearfix"/);
    const block = spoiler ? spoiler[1] : html;
    const urls = [];
    for (const m of block.matchAll(/(?:src|data-src)="([^"]*\/uploads\/posts\/[^"]+\.(?:jpg|jpeg|png|webp))"/g)) {
      const u = absUrl(BASE, m[1]);
      if (!urls.includes(u)) urls.push(u);
    }
    if (!urls.length) return null;
    return { pages: urls, prevChapterId: null, nextChapterId: null };
  });
}

async function tags() { return []; }
async function tagPage() { return []; }

module.exports = {
  id: 'zakura', name: 'zakura.su', base: BASE, maxPages: 13,
  catalogPage, detail, chapters, pages, tags, tagPage,
};
