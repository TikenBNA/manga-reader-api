'use strict';
/**
 * Источник: hentaichan.live (он же «Хентай-тян», зеркало x17.h-chan.me) — русская хентай-манга.
 *
 *   каталог:  /manga/ (стр. 1), /manga/page/N/ (остальные)
 *   пост:     /manga/<id>-<slug>.html   (один пост = одна глава)
 *   читалка:  /online/<id>-<slug>.html?cacheId=…  →  var data = { "fullimg": [ … ] }
 */
const { fetchText, stripTags, absUrl } = require('./http');
const tagsIndex = require('./tags');

const BASE = 'https://hentaichan.live';
const TIMEOUT_MS = 40000;   // сайт медленный: 6–11 с на страницу (страницы глав)
const DETAIL_TIMEOUT = 12000; // карточку не ждём дольше — есть fallback на каталог
const known = new Map();     // extId → карточка из каталога (на случай медленной страницы)

/** Часть CDN-хостов (img4/mimg4) у провайдера не отвечает — переводим на рабочий img2. */
const fixHost = (url) => String(url || '')
  .replace(/^https?:\/\/(?:[a-z0-9-]*\.)?imgschan\.xyz\//i, 'https://img2.imgschan.xyz/')
  .replace('/showfull_retina/manga/', '/manganew_thumbs/'); // обложка-превью вместо 10-МБ retina

const cache = new Map();
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const v = await fn();
  if (v != null && !(Array.isArray(v) && !v.length)) cache.set(key, { exp: Date.now() + ttl, value: v }); // пустоту не кэшируем
  return v;
};

async function catalogPage(page) {
  return cached(`p:${page}`, 6 * 3600e3, async () => {
    const url = page <= 1 ? `${BASE}/manga/` : `${BASE}/manga/page/${page}/`;
    const html = await fetchText(url).catch(() => '');
    const out = [];
    for (const m of html.matchAll(/<div class="content_row" title="([^"]*)">([\s\S]{0,1500}?)<\/div>\s*<\/div>/g)) {
      const block = m[2];
      const link = block.match(/href="[^"]*\/manga\/(\d+)-([a-z0-9_\-]+)\.html"[^>]*class="title_link"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/<a href="[^"]*\/manga\/(\d+)-([a-z0-9_\-]+)\.html"[^>]*title="([^"]*)"/i);
      if (!link) continue;
      const extId = `${link[1]}-${link[2]}`;
      const title = stripTags(link[3]) || stripTags(m[1]);
      const cover = (block.match(/<img[^>]*src="([^"]*(?:manganew_thumbs|manga_thumbs)[^"]+)"/i) || [])[1];
      if (!title || out.some((x) => x.extId === extId)) continue;
      const item = { extId, title, url: `${BASE}/manga/${extId}.html`, cover: cover ? fixHost(absUrl(BASE, cover)) : null };
      known.set(extId, item);
      out.push(item);
    }
    return out;
  });
}

async function detail(extId) {
  return cached(`d:${extId}`, 12 * 3600e3, async () => {
    const html = await fetchText(`${BASE}/manga/${extId}.html`, 0, DETAIL_TIMEOUT).catch(() => '');
    if (!html) {
      const k = known.get(extId); // страница не ответила — отдаём данные из каталога
      return k
        ? { extId, title: k.title, url: k.url, cover: k.cover, author: '', genres: [], description: '', date: null, chapterNumber: 1, chapterTitle: k.title }
        : null;
    }
    const title = stripTags((html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/) || [])[1] || '')
      || stripTags((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').split('&raquo;')[0].trim();
    if (!title) return null;
    const cover = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1]
      || (html.match(/<img id="cover"[^>]*src="([^"]+)"/) || [])[1];
    const genres = [];
    for (const g of html.matchAll(/href="[^"]*\/tags\/[^"]*"[^>]*>([^<]{2,30})</g)) {
      const name = stripTags(g[1]);
      if (name && !genres.includes(name)) { genres.push(name); tagsIndex.note('hchan', name, name); }
    }
    const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    return {
      extId,
      title,
      url: `${BASE}/manga/${extId}.html`,
      cover: cover ? fixHost(absUrl(BASE, cover)) : null,
      author: '',
      genres,
      description: stripTags(desc).slice(0, 700),
      date: null,
      chapterNumber: 1,
      chapterTitle: title,
    };
  });
}

/** Номер главы из слага: «…-glava-6» → 6 (бывает 6.1 и «chast-2»). */
function chapterNumber(extId) {
  const m = String(extId).match(/(?:glava|chapter|ch)[-_]?(\d+(?:[.,]\d+)?)/i);
  if (m) return Number(m[1].replace(',', '.'));
  return null;
}

/**
 * Пост = глава, поэтому собираем все главы серии поиском по названию
 * и оставляем только посты с тем же базовым слагом.
 */
async function chapters(extId) {
  return cached(`ch:${extId}`, 3 * 3600e3, async () => {
    const d = await detail(extId).catch(() => null);
    const baseSlug = String(extId).replace(/^\d+-/, '').replace(/-(?:glava|chapter|ch)[-_]?\d+.*$/i, '');

    const list = [];
    const add = (id, title, num) => {
      if (!id || list.some((x) => x.extId === id)) return;
      list.push({ extId: id, number: num ?? chapterNumber(id) ?? list.length + 1, title: title || `Глава ${num ?? ''}`, date: null });
    };

    add(extId, d?.title || '', chapterNumber(extId));

    // ищем остальные главы серии
    const query = baseSlug.replace(/[-_]+/g, ' ').trim();
    if (query) {
      const url = `${BASE}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
      const html = await fetchText(url, 0, TIMEOUT_MS).catch(() => '');
      for (const m of html.matchAll(/href="[^"]*\/manga\/(\d+-[a-z0-9_\-]+)\.html"[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
        const id = m[1];
        const slugOnly = id.replace(/^\d+-/, '');
        if (slugOnly !== baseSlug && !slugOnly.startsWith(baseSlug + '-')) continue; // только эта серия
        add(id, stripTags(m[2]), chapterNumber(id));
      }
    }

    return list.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
  });
}

async function pages(extId) {
  return cached(`pg:${extId}`, 3 * 3600e3, async () => {
    // читалка доступна напрямую, без захода на страницу поста (экономит один медленный запрос)
    const readerUrl = `${BASE}/online/${extId}.html`;
    const page = await fetchText(readerUrl, 0, TIMEOUT_MS).catch(() => '');
    if (!page) return null;
    const lang = (page.match(/"language"\s*:\s*"([^"]*)"/) || [])[1] || '';
    if (lang && !/рус/i.test(lang)) return null; // только переводы на русский
    const block = (page.match(/"fullimg"\s*:\s*\[([\s\S]*?)\]/) || [])[1];
    if (!block) return null;
    const urls = [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => fixHost(m[1])).filter(Boolean);
    if (!urls.length) return null;
    return { pages: urls, prevChapterId: null, nextChapterId: null };
  });
}

async function tags() { return []; }
async function tagPage() { return []; }

module.exports = {
  id: 'hchan', name: 'hentaichan.live', base: BASE, maxPages: 200,
  catalogPage, detail, chapters, pages, tags, tagPage,
};
