'use strict';
/** Общие утилиты для адаптеров источников. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, attempt = 0, timeoutMs = TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

/** Отрезает хвосты нумерации: «- глава 3», «Том - 1 Глава - 4», «часть 2». */
function stripChapterSuffix(title) {
  const tail = String.raw`\s*(?:[([][^()\[\]]*[)\]])?\s*$`;
  const kw = String.raw`том|volume|vol|глава|главы|главу|часть|chapter|ch|part`;
  const num = String.raw`\s*[.\-–—:№#]?\s*\d+(?:\s*[-–—]\s*\d+)?`;
  return String(title).trim()
    // «[Russian]» / «(перевод)» в конце — убираем сразу, иначе номер главы перед ними не отрезать
    .replace(/\s*[\[(]\s*(?:russian|rus|ru|перевод|пер\.)\s*[\])]\s*$/i, '')
    // хвост в скобках: «(Part 1)», «[Том 2]», «(глава 3)»
    .replace(new RegExp(String.raw`\s*[([{]\s*(?:${kw})${num}\s*[)\]}]?\s*$`, 'i'), '')
    // обычный хвост: «- Part.1», «Том 2», «глава 5», «Часть 3-4» (+ возможная пометка в скобках)
    .replace(new RegExp(String.raw`\s*[-–—:|]?\s*(?:${kw})${num}${tail}`, 'i'), '')
    // «№5», «#5», «no.5» в конце
    .replace(/\s*[-–—]?\s*(?:№|#|no)\s*\.?\s*\d+\s*$/i, '')
    // хвостовое число без ключевого слова: «Мама это должна быть ты 5» → «Мама это должна быть ты»
    .replace(/\s+\d{1,3}(?:[.,]\d+)?\s*$/, '')
    // «Холодный свет 2 - Огонь предка» → «Холодный свет»
    .replace(/\s+\d{1,3}(?:[.,]\d+)?\s*[-–—:|]\s*[\s\S]*$/, '')
    // пометки языка/перевода и теги-метки в конце: «[Russian]», «[diqkz]», «[Uncensored]»
    .replace(/(?:\s*[\[(]\s*(?:russian|rus|ru|english|eng|uncensored|перевод|пер\.)\s*[\])])+\s*$/i, '')
    .replace(/(?:\s*\[[a-z0-9_\-]{2,15}\])+\s*$/i, '')
    .replace(/^[\s\-–—:|]+/, '')
    .replace(/[\s\-–—.,:;]+$/, '')
    .trim();
}

/** Ключ дедупликации работ (межсайтовый). */
function workKey(title) {
  // «[ALAMAMA] AT THE BEACH - CH1 | НА ПЛЯЖЕ - часть 1» → берём русский сегмент,
  // иначе одинаковые работы с разных сайтов не склеиваются
  let src = String(title);
  const segs = src.split(/\s*\|\s*|\s+\/\s+/);
  if (segs.length > 1) {
    const cyr = segs.filter((s) => /[а-яё]/i.test(s));
    if (cyr.length) {
      cyr.sort((a, b) => (b.match(/[а-яё]/gi) || []).length - (a.match(/[а-яё]/gi) || []).length);
      src = cyr[0];
    }
  }
  // для ключа режем номер главы «до конца строки», даже если дальше скобки с русским названием —
  // иначе «Sweet guy - глава 17 (…)» и «Sweet guy - глава 18 (…)» не склеятся
  const aggressive = String(src)
    // теги-пометки в квадратных скобках: «[Russian]», «[diqkz]», «[Uncensored]»
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    // «…First №2 / История…» — номер части в середине, дальше идёт перевод названия
    .replace(/\s*(?:№|#)\s*\d+(?:[.,]\d+)?[\s\S]*$/i, '')
    // «Холодный свет 3 - Глаза Люси» — номер части с подзаголовком
    .replace(/\s+\d{1,3}(?:[.,]\d+)?\s*[-–—:|]\s*[\s\S]*$/i, '')
    .replace(
      /\s*[-–—:|]?\s*(?:том|volume|vol|глава|главы|главу|часть|chapter|ch|part)\s*[.\-–—:№#]?\s*\d+[\s\S]*$/i,
      '',
    );
  // «Мама это должна быть ты 5» и «… 4» — это части одной работы, хвостовое число режем
  const noPart = aggressive.replace(/\s+(?:№|#)?\s*\d{1,3}(?:[.,]\d+)?\s*$/, (m, off, str) => {
    const rest = str.slice(0, str.length - m.length).trim();
    return rest.length >= 6 ? '' : m;
  });
  const base = noPart || stripChapterSuffix(title) || String(title);
  return base
    .toLowerCase()
    .replace(/ё/g, 'е')
    // короткие числа-номера частей где угодно: «Бессмертный аукцион 2 / Immortal Auction»
    .replace(/(^|[\s/|,;:–—-])\d{1,3}(?=[\s/|,;:–—-]|$)/g, '$1 ')
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

module.exports = { UA, fetchText, fetchJson, decode, stripTags, absUrl, workKey, tagKey, stripChapterSuffix, sleep };
