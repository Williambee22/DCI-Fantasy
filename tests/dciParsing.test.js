const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNumbers,
  extractStandardRowScores,
  parseDateFromText
} = require('../src/services/dciParsing');

test('standard recap row extracts eight caption pairs', () => {
  const row = [
    8.2, 5, 8.3, 4, 16.5, 4,
    8.0, 5, 7.7, 5, 15.7, 5,
    32.2, 5,
    8.3, 5, 8.3, 4, 16.6, 5,
    8.5, 4, 8.5, 4, 17.0, 4,
    8.2, 5, 8.0, 5, 16.2, 5,
    24.9, 5,
    8.3, 4, 8.1, 4, 16.4, 4,
    8.4, 4, 8.3, 4, 16.7, 4,
    8.3, 5, 8.1, 5, 16.4, 5
  ];
  const scores = extractStandardRowScores(row);
  assert.deepEqual(scores.GE1, { first: 8.2, second: 8.3 });
  assert.deepEqual(scores.VP, { first: 8.3, second: 8.3 });
  assert.deepEqual(scores.BRASS, { first: 8.3, second: 8.1 });
  assert.deepEqual(scores.PERC, { first: 8.3, second: 8.1 });
  assert.equal(Object.keys(scores).length, 8);
});

test('date parsing prefers the configured season over stale page dates', () => {
  const text = 'August 7, 2024 Indianapolis, IN July 24, 2026 Madison, WI';
  assert.equal(parseDateFromText(text, 2026), '2026-07-24');
});

test('number parsing retains score and rank order', () => {
  assert.deepEqual(parseNumbers('8.200 5 8.300 4 16.500 4'), [8.2, 5, 8.3, 4, 16.5, 4]);
});
