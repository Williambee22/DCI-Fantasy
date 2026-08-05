const SCORE_LAYOUT = [
  {
    captionCode: 'GE1',
    firstIndex: 0,
    secondIndex: 2
  },
  {
    captionCode: 'GE2',
    firstIndex: 6,
    secondIndex: 8
  },
  {
    captionCode: 'VP',
    firstIndex: 14,
    secondIndex: 16
  },
  {
    captionCode: 'VA',
    firstIndex: 20,
    secondIndex: 22
  },
  {
    captionCode: 'CG',
    firstIndex: 26,
    secondIndex: 28
  },
  {
    captionCode: 'BRASS',
    firstIndex: 34,
    secondIndex: 36
  },
  {
    captionCode: 'MA',
    firstIndex: 40,
    secondIndex: 42
  },
  {
    captionCode: 'PERC',
    firstIndex: 46,
    secondIndex: 48
  }
];

function pasteError(message) {
  return Object.assign(
    new Error(message),
    { status: 400 }
  );
}

function normalizeCell(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(value) {
  return normalizeCell(value).toLowerCase();
}

function parseScore(
  value,
  corpsName,
  captionCode,
  label
) {
  const score = Number(normalizeCell(value));

  if (
    !Number.isFinite(score)
    || score < 0
    || score > 10
  ) {
    throw pasteError(
      `${corpsName}: could not read ${captionCode} ${label} from "${value || ''}".`
    );
  }

  return score;
}

/**
 * Supports recap data copied with either:
 * - one table cell per line
 * - tab-separated cells
 */
function splitPasteLines(rawText) {
  return String(rawText || '')
    .replace(/\r/g, '')
    .split('\n')
    .flatMap((line) => {
      const tabCells = line
        .split('\t')
        .map(normalizeCell)
        .filter(Boolean);

      if (tabCells.length > 1) {
        return tabCells;
      }

      return [normalizeCell(line)];
    })
    .filter(Boolean);
}

function parseRecapPaste(rawText, corpsRows) {
  const lines = splitPasteLines(rawText);

  if (!lines.length) {
    throw pasteError(
      'Paste recap scores before importing.'
    );
  }

  const corpsByName = new Map(
    corpsRows.map((corps) => [
      nameKey(corps.name),
      corps
    ])
  );

  const blocks = [];
  let currentBlock = null;

  for (const line of lines) {
    const matchedCorps = corpsByName.get(
      nameKey(line)
    );

    if (matchedCorps) {
      if (currentBlock) {
        blocks.push(currentBlock);
      }

      currentBlock = {
        corps: matchedCorps,
        values: []
      };

      continue;
    }

    if (currentBlock) {
      currentBlock.values.push(line);
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  if (!blocks.length) {
    throw pasteError(
      'No known corps names were found. Begin the pasted recap with a corps name such as "Bluecoats".'
    );
  }

  const seenCorps = new Set();

  return blocks.map(({ corps, values }) => {
    if (seenCorps.has(corps.id)) {
      throw pasteError(
        `${corps.name} appears more than once in the pasted recap.`
      );
    }

    seenCorps.add(corps.id);

    /*
     * The eighth caption's second score is located
     * at position 48, so at least 49 cells are needed.
     */
    if (values.length < 49) {
      throw pasteError(
        `${corps.name}: expected at least 49 recap cells after the corps name, but found ${values.length}.`
      );
    }

    const scores = SCORE_LAYOUT.map(
      ({
        captionCode,
        firstIndex,
        secondIndex
      }) => ({
        captionCode,

        firstScore: parseScore(
          values[firstIndex],
          corps.name,
          captionCode,
          'first score'
        ),

        secondScore: parseScore(
          values[secondIndex],
          corps.name,
          captionCode,
          'second score'
        )
      })
    );

    return {
      corpsId: corps.id,
      corpsName: corps.name,
      scores
    };
  });
}

module.exports = {
  parseRecapPaste,
  SCORE_LAYOUT
};
