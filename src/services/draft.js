function snakeUserId(members, pickNumber) {
  if (!Array.isArray(members) || members.length === 0 || pickNumber < 1) return null;
  const ordered = [...members].sort((a, b) => a.draft_position - b.draft_position);
  const roundIndex = Math.floor((pickNumber - 1) / ordered.length);
  const withinRound = (pickNumber - 1) % ordered.length;
  const index = roundIndex % 2 === 0
    ? withinRound
    : ordered.length - 1 - withinRound;
  return ordered[index].user_id;
}

function draftRound(memberCount, pickNumber) {
  if (!memberCount || pickNumber < 1) return 0;
  return Math.floor((pickNumber - 1) / memberCount) + 1;
}

function totalDraftPicks(memberCount, rosterSize) {
  return memberCount * rosterSize;
}

module.exports = { snakeUserId, draftRound, totalDraftPicks };
