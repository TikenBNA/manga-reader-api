'use strict';
/**
 * Источник: online.hentaimoody.com (DLE).
 * Каталог — /page/N/, карточка .manga-card; тайтл /<id>-slug.html;
 * главы — JSON-манифест, который отдаёт страница /<id>/mangaonline;
 * страницы главы — images.json, ссылка на него тоже на /<chapterId>/mangaonline.
 */
const { fetchText, fetchJson, stripTags, absUrl } = require('./http');

const BASE = 'https://online.hentaimoody.com';
const IMG_CDN = 'https://2img.imghmd.link';
const cache = new Map();

const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  cache.set(key, { exp: Date.now() + ttl, value: v });
  return v;
};

function parseCards(html) {
  const out = [];
  const re = /<article class="manga-card[^"]*"[^>]*data-manga-slug="([^"]*)"[\s\S]*?<a class="manga-card__link" href="([^"]+)"[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<span class="manga-card__title">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const hit = m[2].match(/\/(\d+)-([^/?#]+)\.html/);
    if (!hit) continue;
    out.push({ extId: hit[1], title: stripTags(m[4]), url: m[2], cover: absUrl(BASE, m[3]), slug: hit[2] });
  }
  return out;
}

async function catalogPage(page) {
  const url = page <= 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
  return cached(`p:${page}`, 5 * 60e3, async () => parseCards(await fetchText(url).catch(() => '')));
}

async function detail(extId) {
  return cached(`d:${extId}`, 30 * 60e3, async () => {
    const html = await fetchText(`${BASE}/${extId}-x.html`).catch(() => '');
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (!h1) return null;
    const cover = (html.match(/<img class="title-hero__cover"[^>]+src="([^"]+)"/) || [])[1];
    const genres = [...html.matchAll(/<div class="title-hero__genres">([\s\S]*?)<\/div>/g)]
      .flatMap((x) => [...x[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((a) => stripTags(a[1])));
    const desc = (html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [])[1] || '';
    return {
      extId,
      title: stripTags(h1[1]),
      url: `${BASE}/${extId}-x.html`,
      cover: absUrl(BASE, cover),
      author: '',
      genres,
      description: desc,
    };
  });
}

async function readerHtml(id) {
  return fetchText(`${BASE}/${id}/mangaonline`).catch(() => '');
}

async function manifestUrl(mangaExtId) {
  const html = await readerHtml(mangaExtId);
  return (html.match(/(https:\/\/json\.imghmd\.link\/json-fullstory\/[^"']+\.json)/) || [])[1] || null;
}

async function chapters(extId) {
  return cached(`ch:${extId}`, 10 * 60e3, async () => {
    const url = await manifestUrl(extId);
    if (!url) return [];
    const data = await fetchJson(url).catch(() => null);
    if (!data) return [];
    return Object.entries(data)
      // значения в манифесте — массивы из одного объекта
      .map(([id, raw]) => [id, Array.isArray(raw) ? raw[0] : raw])
      // запись самой манги (category 4, chapter 0) в список глав не берём
      .filter(([, v]) => v && Number(v.category) !== 4 && !(Number(v.chapter) === 0 && Number(v.volume) === 0))
      .map(([id, v]) => ({
        extId: id,
        number: Number(v.chapter) || null,
        title: v.title?.trim() || `Глава ${v.chapter ?? ''}`.trim(),
        date: v.date || null,
        _v: Number(v.volume) || 0,
        _p: Number(v.part) || 0,
      }))
      .sort((a, b) => a._v - b._v || a.number - b.number || a._p - b._p)
      .map(({ _v, _p, ...c }, i) => ({ ...c, number: c.number ?? i + 1 }));
  });
}

async function pages(chapterExtId) {
  return cached(`pg:${chapterExtId}`, 60 * 60e3, async () => {
    const html = await readerHtml(chapterExtId);
    const imagesUrl = (html.match(/(https:\/\/json\.imghmd\.link\/images\/[^"']+images\.json[^"']*)/) || [])[1];
    if (!imagesUrl) return null;
    const list = await fetchJson(imagesUrl).catch(() => []);
    const pages = list.map((x) => (x.url?.startsWith('http') ? x.url : IMG_CDN + x.url));
    // соседние главы: манифест манги есть и на странице главы, id манги — запись category 4
    let prevChapterId = null;
    let nextChapterId = null;
    const manifest = (html.match(/(https:\/\/json\.imghmd\.link\/json-fullstory\/[^"']+\.json)/) || [])[1];
    if (manifest) {
      const data = await fetchJson(manifest).catch(() => null);
      if (data) {
        const mangaRecord = Object.entries(data)
          .map(([id, raw]) => [id, Array.isArray(raw) ? raw[0] : raw])
          .find(([, v]) => v && Number(v.category) === 4);
        if (mangaRecord) {
          const [mangaId] = mangaRecord;
          const chs = await chapters(mangaId).catch(() => []);
          const idx = chs.findIndex((c) => String(c.extId) === String(chapterExtId));
          if (idx > 0) prevChapterId = chs[idx - 1].extId;
          if (idx >= 0 && idx < chs.length - 1) nextChapterId = chs[idx + 1].extId;
        }
      }
    }
    return { pages, prevChapterId, nextChapterId };
  });
}

module.exports = { id: 'moody', name: 'online.hentaimoody.com', base: BASE, maxPages: 200, catalogPage, detail, chapters, pages, tags: async () => [] };
