const test = require('node:test');
const assert = require('node:assert/strict');
const { snakeUserId, draftRound, totalDraftPicks } = require('../src/services/draft');

const members = [
  { user_id: 'a', draft_position: 1 },
  { user_id: 'b', draft_position: 2 },
  { user_id: 'c', draft_position: 3 }
];

test('snake draft reverses every other round', () => {
  const sequence = Array.from({ length: 9 }, (_, index) => snakeUserId(members, index + 1));
  assert.deepEqual(sequence, ['a', 'b', 'c', 'c', 'b', 'a', 'a', 'b', 'c']);
});

test('draft round and total picks are calculated correctly', () => {
  assert.equal(draftRound(3, 1), 1);
  assert.equal(draftRound(3, 4), 2);
  assert.equal(draftRound(3, 7), 3);
  assert.equal(totalDraftPicks(6, 8), 48);
});
