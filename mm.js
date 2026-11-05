'use strict';
/** Источник: multi-manga.com (DLE). */
const { fetchText, fetchJson, stripTags, absUrl, workKey } = require('./http');

const BASE = process.env.MM_BASE || 'https://multi-manga.com';
const cache = new Map();
const urlCache = new Map();

const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  cache.set(key, { exp: Date.now() + ttl, value: v });
  return v;
};

const CARD_RE = /<a\s+href="(https?:\/\/[^"]+\/\d+-[^"]+\.html)"\s+class="cover"[\s\S]*?data-src="([^"]+)"[\s\S]*?<div class="caption"[^>]*>([\s\S]*?)<\/div>/g;

function parseCards(html) {
  const out = [];
  const seen = new Set();
  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(html))) {
    const [, url, img, caption] = m;
    const hit = url.match(/\/(\d+)-([^/?#]+)\.html/);
    if (!hit || seen.has(hit[1])) continue;
    seen.add(hit[1]);
    urlCache.set(hit[1], `${BASE}/${hit[1]}-${hit[2]}.html`);
    out.push({ extId: hit[1], title: stripTags(caption), url: `${BASE}/${hit[1]}-${hit[2]}.html`, cover: absUrl(BASE, img) });
  }
  return out;
}

function parseDetail(html, extId) {
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/);
  if (!h1) return null;
  const title = stripTags(h1[1]);
  const field = (label) => {
    const m = html.match(new RegExp(`${label}\\s*<span class="tags">([\\s\\S]*?)<\\/span>`));
    return m ? stripTags(m[1]) : '';
  };
  const tagBlock = html.match(/<div class="tag-container field-name\s*">\s*Теги\s*<span class="tags">([\s\S]*?)<\/span>/);
  const genres = [];
  if (tagBlock) {
    const re = /<a class="tag"[^>]*>([\s\S]*?)<\/a>/g;
    let t;
    while ((t = re.exec(tagBlock[1]))) {
      const g = stripTags(t[1]);
      if (g) genres.push(g);
    }
  }
  const date = (html.match(/<time datetime="([^"]+)"/) || [])[1] || null;
  const pagesCount = Number((html.match(/(\d+)\s*страниц/) || [])[1] || 1);
  const cover = (html.match(/id="cover"[\s\S]*?data-src="([^"]+)"/) || [])[1];
  const desc = (html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [])[1] || '';

  return { extId, title, url: `${BASE}/${extId}-x.html`, author: field('Автор'), genres, date, pagesCount, cover: absUrl(BASE, cover), description: desc };
}

/** Совместимость с прежним кодом: главы ищутся поиском по названию работы. */
async function detail(extId) {
  return cached(`d:${extId}`, 30 * 60e3, async () => {
    const url = urlCache.get(extId) || `${BASE}/${extId}-x.html`;
    const html = await fetchText(url).catch(() => '');
    const d = parseDetail(html, extId);
    if (!d) return null;
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/i) || [])[1];
    if (canonical) { d.url = canonical; urlCache.set(extId, canonical); }
    return d;
  });
}

async function catalogPage(page) {
  const url = page <= 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
  return cached(`p:${page}`, 5 * 60e3, async () => parseCards(await fetchText(url).catch(() => '')));
}

const workName = (title) => title.replace(/\s*[-–—]\s*(глава|главы|часть|chapter|part).*$/i, '').trim() || title;

async function chapters(extId) {
  const seed = await detail(extId);
  if (!seed) return [];
  const name = workName(seed.title);
  const key = workKey(name);
  return cached(`ch:${key}`, 10 * 60e3, async () => {
    const html = await fetchText(`${BASE}/index.php?do=search&subaction=search&story=${encodeURIComponent(name)}`).catch(() => '');
    const cards = parseCards(html);
    const out = [];
    for (const c of cards) {
      const d = await detail(c.extId).catch(() => null);
      if (!d || workKey(workName(d.title)) !== key) continue;
      const num = (d.title.match(/(?:глав[аыу]?|часть|chapter|part)\s*(\d+(?:[.,]\d+)?)/i) || [])[1];
      out.push({ extId: c.extId, number: num ? Number(num.replace(',', '.')) : null, title: d.title, date: d.date });
    }
    out.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || String(a.date).localeCompare(String(b.date)));
    return out.map((c, i) => ({ ...c, number: c.number ?? i + 1 }));
  });
}

function parseImages(html) {
  const out = [];
  const re = /<div class="thumb-container">[\s\S]*?data-src="([^"]+\.(?:webp|jpg|jpeg|png))"/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = absUrl(BASE, m[1]);
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

async function pages(chapterExtId) {
  return cached(`pg:${chapterExtId}`, 60 * 60e3, async () => {
    const d = await detail(chapterExtId);
    if (!d) return null;
    const baseUrl = d.url.replace(/\/$/, '');
    const total = Math.max(1, d.pagesCount);
    const list = [];
    for (const u of parseImages(await fetchText(baseUrl).catch(() => ''))) list.push(u);
    for (let p = 2; p <= total && list.length < total; p++) {
      for (const u of parseImages(await fetchText(`${baseUrl}/${p}/`).catch(() => ''))) if (!list.includes(u)) list.push(u);
    }
    const chs = await chapters(chapterExtId).catch(() => []);
    const idx = chs.findIndex((c) => c.extId === chapterExtId);
    return {
      pages: list,
      prevChapterId: idx > 0 ? chs[idx - 1].extId : null,
      nextChapterId: idx >= 0 && idx < chs.length - 1 ? chs[idx + 1].extId : null,
    };
  });
}

async function tags() {
  const out = [];
  try {
    const xml = await fetchText(`${BASE}/tags_pages.xml`);
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const hit = m[1].match(/\/tags\/([^/]+)\/$/);
      if (hit) out.push({ slug: decodeURIComponent(hit[1]), name: decodeURIComponent(hit[1]).replace(/-/g, ' ') });
    }
  } catch { /* ignore */ }
  return out;
}

async function tagPage(slug, page) {
  const url = page <= 1 ? `${BASE}/tags/${encodeURIComponent(slug)}/` : `${BASE}/tags/${encodeURIComponent(slug)}/page/${page}/`;
  return cached(`t:${slug}:${page}`, 5 * 60e3, async () => parseCards(await fetchText(url).catch(() => '')));
}

module.exports = {
  id: 'mm', name: 'multi-manga.com', base: BASE, maxPages: 700,
  catalogPage, detail, chapters, pages, tags, tagPage,
};
