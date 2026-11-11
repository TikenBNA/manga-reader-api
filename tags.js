'use strict';
/**
 * Глобальный индекс тегов: собирается из карточек постов (реальные slug'и + подписи)
 * и переживает перезапуск (cache/tags.json). Нужен, чтобы:
 *  - список тегов не «худел» после рестарта;
 *  - фильтр по тегу подставлял slug конкретного источника, а не угадывал его.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'cache', 'tags.json');
const map = new Map(); // `${source}|${slug}` -> { source, slug, name }
let dirty = false;
let timer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const t of raw.tags || []) {
      if (!t || !t.slug) continue;
      map.set(`${t.source}|${t.slug}`, { source: t.source, slug: t.slug, name: t.name || t.slug });
    }
    console.log(`[tags] из кэша: ${map.size}`);
  } catch { /* первого запуска может не быть */ }
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ tags: [...map.values()] }));
  } catch (e) { console.error('[tags] save failed:', e.message); }
}

function note(source, slug, name) {
  if (!source || !slug) return;
  const clean = String(name || slug).trim();
  const key = `${source}|${slug}`;
  const cur = map.get(key);
  if (cur) {
    const cyr = /[а-яё]/i;
    // подпись, полученная из slug'а, заменяем на человеческую, как только увидели её в посте
    if (clean && cur.name !== clean && (!cyr.test(cur.name) || cur.name === cur.slug) && cyr.test(clean)) {
      cur.name = clean; dirty = true;
    }
    return;
  }
  map.set(key, { source, slug, name: clean || slug });
  dirty = true;
  if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 2000);
}

const all = () => [...map.values()];

load();
process.on('exit', flush);

module.exports = { note, all, flush };
