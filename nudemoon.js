'use strict';
/**
 * Источник: kpez.nude-moon.pro (NUDE-MOON).
 * Пост = сразу читалка: /view/<id>-<slug>/ (картинки в data-src).
 * Каталог — / и /page/N/ (карточки a.thumb), теги — /cat/<slug>/ (+ /page/N/).
 */
const { fetchText, stripTags, absUrl, trimCache } = require('./http');
const tagsIndex = require('./tags');

const BASE = 'https://kpez.nude-moon.pro';
const cache = new Map();
const urlCache = new Map();

const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  cache.set(key, { exp: Date.now() + ttl, value: v });
  trimCache(cache, 800);
  return v;
};

/** «0-3 главы», «1-4 главы +бонус», «1-8 глпвы» — это диапазон глав, а не название. */
const isRangeTitle = (s) => {
  const x = String(s || '').trim();
  return !x || /^[\d\s,.+\-–—/]*(?:главы|глава|глав|глпвы|главу|часть|том[а]?)?[\s\d,.+\-–—/]*$/i.test(x);
};

/** Название из адреса: /view/27414-kago-no-naka-no-kotori-...-0-3-glavy/ */
function titleFromSlug(href) {
  let slug = String(href).replace(/^\/view\/\d+-/, '').replace(/\/$/, '');
  slug = slug.replace(/-\d+-\d+-glavy.*$/i, '').replace(/-glava-?\d+.*$/i, '').replace(/-x$/, '');
  const words = slug.split('-').filter(Boolean);
  if (!words.length) return '';
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parseCards(html) {
  const out = [];
  // режем по началу карточки: иначе «ленивый» regex перескакивает в следующую карточку
  // и подтягивает чужую обложку/название (было: заголовок одной манги + картинка другой)
  const chunks = html.split('<a class="thumb');
  for (let i = 1; i < chunks.length; i++) {
    const b = chunks[i];
    const hm = b.match(/href="(\/view\/(\d+)-[^"]+)"/);
    if (!hm) continue;
    const img = (b.match(/data-src="([^"]+)"/) || [])[1];
    const tm = b.match(/thumb__title[^"]*">([\s\S]*?)<\/div>/);
    const [, href, extId] = hm;
    let title = tm ? stripTags(tm[1]) : '';
    // у части старых постов в заголовке карточки только диапазон глав — берём название из адреса
    if (isRangeTitle(title)) title = titleFromSlug(href);
    if (!title || !img) continue;
    urlCache.set(extId, BASE + href);
  trimCache(urlCache, 5000);
    if (out.some((x) => x.extId === extId)) continue;
    out.push({ extId, title, url: BASE + href, cover: absUrl(BASE, img) });
  }
  return out;
}

async function catalogPage(page) {
  const url = page <= 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
  return cached(`p:${page}`, 5 * 60e3, async () => parseCards(await fetchText(url).catch(() => '')));
}

async function viewHtml(extId) {
  const url = urlCache.get(extId) || `${BASE}/view/${extId}-x/`;
  return fetchText(url).catch(() => '');
}

async function detail(extId) {
  return cached(`d:${extId}`, 30 * 60e3, async () => {
    const html = await viewHtml(extId);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (!h1) return null;
    const genres = [];
    for (const m of html.matchAll(/href="\/cat\/([^"/]+)\/"/g)) {
      const slug = m[1];
      const name = slug.replace(/-/g, ' ');
      if (!genres.includes(name)) genres.push(name);
      tagsIndex.note('nudemoon', slug, name);
    }
    const cover = (html.match(/data-src="(https?:\/\/[^"]+\.(?:webp|jpg|jpeg|png))"/i) || [])[1];
    const desc = (html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [])[1] || '';
    const title = stripTags(h1[1]).replace(/\s*—\s*хентай манга$/i, '');
    return { extId, title, url: urlCache.get(extId) || `${BASE}/view/${extId}-x/`, cover: absUrl(BASE, cover), author: '', genres, description: desc };
  });
}

async function chapters(extId) {
  // каждый /view/ — самостоятельная глава; соседей ищем по индексу каталога (его даёт реестр)
  return cached(`ch:${extId}`, 30 * 60e3, async () => {
    const d = await detail(extId);
    if (!d) return [];
    const num = Number((d.title.match(/(?:№|#)\s*(\d+)/) || [])[1]) || null;
    return [{ extId, number: num ?? 1, title: d.title, date: null }];
  });
}

async function pages(chapterExtId) {
  return cached(`pg:${chapterExtId}`, 60 * 60e3, async () => {
    const html = await viewHtml(chapterExtId);
    const out = [];
    const re = /data-src="(https?:\/\/[^"]+\.(?:webp|jpg|jpeg|png))"/gi;
    let m;
    while ((m = re.exec(html))) {
      const u = absUrl(BASE, m[1]);
      if (!out.includes(u)) out.push(u);
    }
    if (!out.length) return null;
    return { pages: out, prevChapterId: null, nextChapterId: null };
  });
}

async function tags() {
  return cached('tags', 6 * 3600e3, async () => {
    const html = await fetchText(`${BASE}/tags/`).catch(() => '');
    const seen = new Map();
    for (const m of html.matchAll(/href="\/cat\/([^"/]+)\/"/g)) {
      const slug = m[1];
      if (!seen.has(slug)) {
        const name = slug.replace(/-/g, ' ');
        seen.set(slug, { slug, name });
        tagsIndex.note('nudemoon', slug, name);
      }
    }
    return [...seen.values()];
  });
}

async function tagPage(slug, page) {
  const url = page <= 1 ? `${BASE}/cat/${encodeURIComponent(slug)}/` : `${BASE}/cat/${encodeURIComponent(slug)}/page/${page}/`;
  return cached(`t:${slug}:${page}`, 5 * 60e3, async () => parseCards(await fetchText(url).catch(() => '')));
}

module.exports = { id: 'nudemoon', name: 'kpez.nude-moon.pro', base: BASE, maxPages: 400, catalogPage, detail, chapters, pages, tags, tagPage };
