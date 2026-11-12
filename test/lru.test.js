'use strict';
/** Ограничитель кэшей: старые записи вытесняются, новые остаются. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { trimCache } = require('../http');

test('trimCache: держит не больше max и вытесняет самые старые', () => {
  const m = new Map();
  for (let i = 0; i < 10; i += 1) m.set('k' + i, i);
  trimCache(m, 3);
  assert.equal(m.size, 3);
  assert.deepEqual([...m.keys()], ['k7', 'k8', 'k9']);
});

test('trimCache: маленький кэш не трогает', () => {
  const m = new Map([['a', 1], ['b', 2]]);
  trimCache(m, 5);
  assert.equal(m.size, 2);
});

test('trimCache: некорректные аргументы не ломают вызов', () => {
  const m = new Map([['a', 1]]);
  assert.equal(trimCache(null, 5), null);
  assert.equal(trimCache(m, 0), m);
  assert.equal(m.size, 1);
});
