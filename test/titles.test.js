'use strict';
/**
 * Тесты нормализации названий и разбора id.
 * Запуск: npm test  (node --test test/)
 *
 * Эти функции ломались уже несколько раз (хвостовые номера частей, кириллица в \b,
 * пометки [Russian], диапазоны глав), поэтому фиксируем поведение тестами.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { workKey, stripChapterSuffix } = require('../http');
const { displayTitle, sortKey, partNumber, isChapterRange, parseId } = require('../registry');

test('workKey: части серии с хвостовым номером', () => {
  assert.equal(workKey('Мама это должна быть ты 5'), workKey('Мама это должна быть ты 4'));
  assert.equal(workKey('Помощь Кохаю 7'), workKey('Помощь Кохаю'));
});

test('workKey: номер с подзаголовком', () => {
  const a = workKey('[Eugenio Sicomoro] Холодный свет #1 [Russian]');
  const b = workKey('[Eugenio Sicomoro] Холодный свет 2 - Огонь предка [Russian]');
  const c = workKey('[Eugenio Sicomoro] Холодный свет 3 - Глаза Люси [Russian]');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('workKey: главы в «глава N» и «часть N»', () => {
  assert.equal(workKey('Sweet guy - глава 17 (продолжение)'), workKey('Sweet guy - глава 18'));
  assert.equal(workKey('НА ПЛЯЖЕ - глава 1 (AT THE BEACH - chapter 1)'),
    workKey('[ALAMAMA] AT THE BEACH - CH1 | НА ПЛЯЖЕ - часть 1 [Russian] [diqkz]'));
});

test('workKey: год в названии не режется', () => {
  assert.notEqual(workKey('День святого Валентина 2026'), workKey('День святого Валентина'));
});

test('workKey: сезоны склеиваются', () => {
  const base = workKey('JK Taimabu');
  for (const t of ['JK Taimabu Season 1', 'JK Taimabu 2 сезон', 'JK Taimabu Сезон 3', 'JK Taimabu 2nd Season']) {
    assert.equal(workKey(t), base, t);
  }
});

test('displayTitle: диапазон глав не становится названием', () => {
  assert.equal(displayTitle('Kago no Naka no Kotori wa Itsu Deyaru (0-3 главы) / Kago no Naka'), 'Kago no Naka no Kotori wa Itsu Deyaru');
  assert.equal(displayTitle("[Tachibana-san] Tachibana-san's Circumstances With A Man (1-4 главы +бонус)"), "[Tachibana-san] Tachibana-san's Circumstances With A Man");
});

test('displayTitle: русский сегмент вместо латинского', () => {
  assert.equal(displayTitle('Soft and Slim / Мягкая и стройная'), 'Мягкая и стройная');
});

test('stripChapterSuffix: снимает хвосты и пометки языка', () => {
  assert.equal(stripChapterSuffix('Мама это должна быть ты 5'), 'Мама это должна быть ты');
  assert.equal(stripChapterSuffix('X [Russian]'), 'X');
  assert.equal(stripChapterSuffix('X - глава 3 (Y)'), 'X');
});

test('sortKey: цифры → кириллица → латиница', () => {
  const digits = sortKey('1 день 1 девушка');
  const cyr = sortKey('А вы близки со своей семьей');
  const lat = sortKey('Zutto Akogare');
  assert.ok(digits < cyr, 'цифры должны идти раньше кириллицы');
  assert.ok(cyr < lat, 'кириллица должна идти раньше латиницы');
});

test('sortKey: префикс автора и пунктуация не влияют', () => {
  assert.equal(sortKey('[Eugenio Sicomoro] Холодный свет'), sortKey('Холодный свет'));
  assert.equal(sortKey('«А» Сато-куна'), sortKey('А Сато куна'));
});

test('partNumber: номер части из разных форм', () => {
  assert.equal(partNumber('X - глава 5 (Y)'), 5);
  assert.equal(partNumber('X - часть 2'), 2);
  assert.equal(partNumber('Мама это должна быть ты 7'), 7);
  assert.equal(partNumber('X #3'), 3);
  assert.equal(partNumber('Холодный свет 2 - Огонь предка'), 2);
  assert.equal(partNumber('Просто название'), null);
});

test('isChapterRange: диапазоны глав и не-диапазоны', () => {
  assert.equal(isChapterRange('0-3 главы'), true);
  assert.equal(isChapterRange('1-4 главы +бонус'), true);
  assert.equal(isChapterRange('1-8 глпвы'), true);
  assert.equal(isChapterRange('Том 2'), true);
  assert.equal(isChapterRange('Моя девушка — монстр'), false);
});

test('parseId: источники и обратная совместимость', () => {
  assert.deepEqual(parseId('mm:16737'), { source: 'mm', extId: '16737' });
  assert.deepEqual(parseId('hchan:55772-slug'), { source: 'hchan', extId: '55772-slug' });
  assert.deepEqual(parseId('16737'), { source: 'mm', extId: '16737' });
  assert.equal(parseId('nope:123'), null);
  assert.equal(parseId('mangadex:abc'), null);
});
