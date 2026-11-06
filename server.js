'use strict';
/**
 * MangaReader API — мультиисточниковый прокси.
 *
 *   GET /api/manga?page=1[&source=moody][&tag=<slug>]
 *   GET /api/tags
 *   GET /api/manga/:id                 (id = "mm:16737" | "moody:316941" | "16737")
 *   GET /api/manga/:id/chapters
 *   GET /api/chapter/:id/pages
 *   GET /api/sources
 *   GET /demo
 *
 * Слияние источников — по нормализованному названию работы (см. sources/index.js),
 * поэтому одна и та же манга с двух сайтов попадает в каталог один раз.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('./registry');
const { workKey, tagKey } = require('./http');

const CONFIG = {
  PORT: Number(process.env.PORT || 3001),
  PER_PAGE: Number(process.env.MM_PER_PAGE || 20),
};

const state = registry.state;

const zlib = require('node:zlib');
const gzip = (buf) => zlib.gzipSync(buf, { level: 6 });

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
  if (buf.length > 1024 && /\bgzip\b/.test(accepts)) {
    buf = gzip(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(buf);
}

function json(res, code, body) {
  send(res, code, Buffer.from(JSON.stringify(body), 'utf8'), 'application/json; charset=utf-8');
}

/**
 * Работы, отфильтрованные по тегам (строгое И): работа должна быть на странице
 * каждого выбранного тега. Источники без поддержки тегов в такой фильтр не попадают.
 */
async function taggedList(tags, page, perPage) {
  const perTag = new Map(); // tag -> Map(workKey -> item)

  for (const tag of tags) {
    const byKey = new Map();
    for (const a of registry.adapters) {
      if (!a.tagPage) continue;
      // у каждого источника свой slug тега — берём его из общего индекса
      const slug = await registry.slugFor(a.id, tag);
      if (!slug) continue;
      const items = await a.tagPage(slug, page).catch(() => []);
      for (const it of items) {
        const key = workKey(it.title);
        if (!key) continue;
        const cur = byKey.get(key);
        if (!cur) {
          byKey.set(key, { id: `${a.id}:${it.extId}`, title: it.title, cover: it.cover, author: '', genres: [], sources: [{ source: a.id, id: it.extId, url: it.url }] });
        } else if (!cur.sources.some((s) => s.source === a.id)) {
          cur.sources.push({ source: a.id, id: it.extId, url: it.url });
        }
      }
    }
    perTag.set(tag, byKey);
  }

  // пересечение по ключам: строгое И
  const [firstTag, ...rest] = tags;
  const base = perTag.get(firstTag) || new Map();
  const out = [];
  for (const [key, item] of base) {
    if (rest.every((t) => perTag.get(t)?.has(key))) out.push(item);
    if (out.length >= perPage) break;
  }
  return out;
}

/** Догружает автора/жанры для карточек (и попутно пополняет индекс тегов). */
async function enrichWorks(items) {
  const chunk = 6;
  for (let i = 0; i < items.length; i += chunk) {
    await Promise.all(items.slice(i, i + chunk).map(async (it) => {
      const parsed = registry.parseId(it.id);
      if (!parsed) return;
      const a = registry.findAdapter(parsed.source);
      if (!a) return;
      const d = await a.detail(parsed.extId).catch(() => null);
      if (d) {
        it.author = d.author || '';
        it.genres = d.genres || [];
        it.cover = it.cover || d.cover || '';
        it.date = d.date || null;
      }
    }));
  }
  registry.invalidateTagCache();
  return items;
}
async function apiMangaDetail(id) {
  const parsed = registry.parseId(id);
  if (!parsed) return null;
  const adapter = registry.findAdapter(parsed.source);
  if (!adapter) return null;
  const d = await adapter.detail(parsed.extId);
  if (!d) return null;

  // другие источники с той же работой
  let others = [];
  try {
    const key = workKey(d.title);
    const hit = state.merged?.find((w) => w.key === key);
    if (hit) others = hit.sources.map((s) => ({ source: s.source, id: s.extId, url: s.url }));
  } catch { /* ignore */ }

  return {
    id: `${parsed.source}:${parsed.extId}`,
    title: d.title,
    cover: d.cover,
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
  const list = await adapter.chapters(parsed.extId).catch(() => []);
  return list.map((c) => ({ id: `${parsed.source}:${c.extId}`, number: c.number, title: c.title, date: c.date }));
}

async function apiPages(id) {
  const parsed = registry.parseId(id);
  if (!parsed) return null;
  const adapter = registry.findAdapter(parsed.source);
  if (!adapter) return null;
  const res = await adapter.pages(parsed.extId).catch(() => null);
  if (!res) return null;
  const ns = (v) => (v ? `${parsed.source}:${v}` : null);
  return { pages: res.pages || [], prevChapterId: ns(res.prevChapterId), nextChapterId: ns(res.nextChapterId) };
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
  const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
  const tags = url.searchParams.getAll('tag').map((t) => t.trim()).filter(Boolean);
  const source = url.searchParams.get('source');
  const sort = url.searchParams.get('sort') === 'old' ? 'old' : 'new';

  try {
    if (route === '/') return json(res, 200, {
      ok: true,
      crawling: state.crawling,
      mergedWorks: state.merged?.length ?? null,
      sources: state.sources.map((s) => ({ id: s.id, ready: s.ready, posts: s.posts, works: s.works, scanned: s.scanned, error: s.error })),
      endpoints: ['/api/manga?page=1', '/api/manga?tag=<slug>', '/api/tags', '/api/sources', '/api/manga/<src:id>', '/api/manga/<src:id>/chapters', '/api/chapter/<src:id>/pages'],
      demo: '/demo',
    });

    if (route === '/health') return json(res, 200, {
      ok: !state.crawling,
      crawling: state.crawling,
      mergedWorks: state.merged?.length ?? null,
      sources: state.sources.map((s) => ({ id: s.id, ready: s.ready, posts: s.posts, works: s.works, scanned: s.scanned, error: s.error })),
      uptime: Math.round(process.uptime()),
    });

    if (route === '/api/sources') return json(res, 200, state.sources.map((s) => ({
      id: s.id, name: s.name, base: s.base, ready: s.ready, posts: s.posts, works: s.works, scanned: s.scanned, builtAt: s.builtAt, error: s.error,
    })));

    if (route === '/demo' || route === '/demo.html') {
      const html = await fs.promises.readFile(path.join(__dirname, 'demo.html'));
      return send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }

    if (route === '/api/manga') {
      if (tags.length) {
        const tagged = await taggedList(tags, page, CONFIG.PER_PAGE);
        return json(res, 200, await enrichWorks(sort === 'old' ? tagged.reverse() : tagged));
      }
      const list = registry.listPage(page, CONFIG.PER_PAGE, source, sort);
      if (!list) return json(res, 503, { error: 'catalog not ready', crawling: state.crawling });
      return json(res, 200, await enrichWorks(list));
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

server.listen(CONFIG.PORT, () => {
  console.log(`MangaReader API on http://localhost:${CONFIG.PORT}`);
  console.log('[catalog] источники:', registry.adapters.map((a) => a.id).join(', '));
  registry.warm()
    .then(() => { if (!process.env.MM_NO_TAG_WARM) warmTags(Number(process.env.MM_TAG_WARM || 200)); })
    .catch((e) => console.error('[catalog] warm failed:', e.message));
});
