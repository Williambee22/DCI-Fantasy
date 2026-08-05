const STANDARD_POSITIONS = {
  GE1: [0, 2],
  GE2: [6, 8],
  VP: [14, 16],
  VA: [20, 22],
  CG: [26, 28],
  BRASS: [34, 36],
  MA: [40, 42],
  PERC: [46, 48]
};

function parseNumbers(text) {
  return (String(text).match(/\b\d+(?:\.\d+)?\b/g) || []).map(Number);
}

function validSubcaption(value) {
  return Number.isFinite(value) && value >= 0 && value <= 10;
}

function extractStandardRowScores(numbers) {
  const output = {};
  for (const [caption, [firstIndex, secondIndex]] of Object.entries(STANDARD_POSITIONS)) {
    const first = numbers[firstIndex];
    const second = numbers[secondIndex];
    if (!validSubcaption(first) || !validSubcaption(second)) return null;
    output[caption] = { first, second };
  }
  return output;
}

function dateToIso(month, day, year) {
  const date = new Date(`${month} ${day}, ${year} 12:00:00 UTC`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function parseDateFromText(text, yearHint) {
  const source = String(text);
  const namedPattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/gi;
  const namedMatches = [...source.matchAll(namedPattern)].map((match) => ({
    year: Number(match[3]),
    iso: dateToIso(match[1], match[2], match[3])
  })).filter((item) => item.iso);

  const matchingNamed = namedMatches.filter((item) => item.year === Number(yearHint));
  if (matchingNamed.length) return matchingNamed.at(-1).iso;
  if (namedMatches.length) return namedMatches.at(-1).iso;

  const numericPattern = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  const numericMatches = [...source.matchAll(numericPattern)].map((match) => ({
    year: Number(match[3]),
    iso: `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`
  }));
  const matchingNumeric = numericMatches.filter((item) => item.year === Number(yearHint));
  if (matchingNumeric.length) return matchingNumeric.at(-1).iso;
  if (numericMatches.length) return numericMatches.at(-1).iso;

  return `${yearHint}-01-01`;
}

module.exports = {
  STANDARD_POSITIONS,
  parseNumbers,
  extractStandardRowScores,
  parseDateFromText
};
