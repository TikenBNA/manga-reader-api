'use strict';
/** Общие утилиты для адаптеров источников. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/json,application/xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (e) {
    if (attempt < 2) {
      await sleep(300 * (attempt + 1));
      return fetchText(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, attempt = 0) {
  try {
    return JSON.parse(await fetchText(url, attempt));
  } catch (e) {
    if (attempt < 2) {
      await sleep(300 * (attempt + 1));
      return fetchJson(url, attempt + 1);
    }
    throw e;
  }
}

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#039;': "'", '&apos;': "'",
  '&lt;': '<', '&gt;': '>', '&laquo;': '«', '&raquo;': '»', '&mdash;': '—', '&ndash;': '–',
};
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
const stripTags = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function absUrl(base, u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return base + (u.startsWith('/') ? u : '/' + u);
}

/** Ключ дедупликации работ (межсайтовый). */
function workKey(title) {
  return String(title)
    .replace(/\s*[-–—]\s*(глава|главы|часть|chapter|part)\s*[\dIVXLC]+.*$/i, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(?:№|#|no\.)\s*\d+/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^0-9a-zа-я]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s_-]+/g, ' ')
    .replace(/[^0-9a-zа-я ]+/g, '')
    .trim();
}

module.exports = { UA, fetchText, fetchJson, decode, stripTags, absUrl, workKey, tagKey, sleep };
