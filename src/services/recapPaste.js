const STANDARD_SCORE_LAYOUT = [
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


/*
 * Double-panel recap layout.
 *
 * GE1:
 *   Judge 1
 *   Judge 2
 *
 * GE2:
 *   Judge 1
 *   Judge 2
 *
 * VP:
 *   Judge 1
 *
 * VA:
 *   Judge 1
 *
 * CG:
 *   Judge 1
 *
 * Brass:
 *   Judge 1
 *
 * MA:
 *   Judge 1
 *   Judge 2
 *
 * Percussion:
 *   Judge 1
 */
const DOUBLE_SCORE_LAYOUT = [
  {
    captionCode: 'GE1',

    judges: [
      {
        firstIndex: 0,
        secondIndex: 2
      },

      {
        firstIndex: 6,
        secondIndex: 8
      }
    ]
  },

  {
    captionCode: 'GE2',

    judges: [
      {
        firstIndex: 12,
        secondIndex: 14
      },

      {
        firstIndex: 18,
        secondIndex: 20
      }
    ]
  },

  {
    captionCode: 'VP',

    judges: [
      {
        firstIndex: 26,
        secondIndex: 28
      }
    ]
  },

  {
    captionCode: 'VA',

    judges: [
      {
        firstIndex: 32,
        secondIndex: 34
      }
    ]
  },

  {
    captionCode: 'CG',

    judges: [
      {
        firstIndex: 38,
        secondIndex: 40
      }
    ]
  },

  {
    captionCode: 'BRASS',

    judges: [
      {
        firstIndex: 46,
        secondIndex: 48
      }
    ]
  },

  {
    captionCode: 'MA',

    judges: [
      {
        firstIndex: 52,
        secondIndex: 54
      },

      {
        firstIndex: 58,
        secondIndex: 60
      }
    ]
  },

  {
    captionCode: 'PERC',

    judges: [
      {
        firstIndex: 64,
        secondIndex: 66
      }
    ]
  }
];


/*
 * Keep the old export name available in case another
 * file still imports SCORE_LAYOUT.
 */
const SCORE_LAYOUT =
  STANDARD_SCORE_LAYOUT;


function pasteError(message) {
  return Object.assign(
    new Error(message),
    {
      status: 400
    }
  );
}


function normalizeCell(value) {
  return String(value || '')
    .replace(
      /\u00a0/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}


function nameKey(value) {
  return normalizeCell(
    value
  ).toLowerCase();
}


/*
 * Official fantasy scores are stored to three
 * decimal places.
 */
function round3(value) {
  return (
    Math.round(
      (
        Number(value)
        + Number.EPSILON
      )
      * 1000
    )
    / 1000
  );
}


function parseScore(
  value,
  corpsName,
  captionCode,
  label
) {
  const score =
    Number(
      normalizeCell(value)
    );

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


/*
 * Used only for identifying the layout.
 *
 * Caption totals may be up to 20.
 * GE may be up to 40.
 * Visual/Music may be up to 30.
 */
function parseTotal(
  value,
  maximum
) {
  const total =
    Number(
      normalizeCell(value)
    );

  return (
    Number.isFinite(total)
    && total >= 0
    && total <= maximum
  );
}


function averageTwo(
  first,
  second
) {
  return round3(
    (
      first
      + second
    )
    / 2
  );
}


/**
 * Supports recap data copied with either:
 *
 * - one table cell per line
 * - tab-separated cells
 */
function splitPasteLines(rawText) {
  return String(rawText || '')
    .replace(
      /\r/g,
      ''
    )
    .split('\n')
    .flatMap((line) => {
      const tabCells =
        line
          .split('\t')
          .map(normalizeCell)
          .filter(Boolean);

      if (
        tabCells.length > 1
      ) {
        return tabCells;
      }

      return [
        normalizeCell(line)
      ];
    })
    .filter(Boolean);
}


/*
 * =====================================================
 * PANEL DETECTION
 * =====================================================
 *
 * The double-panel recap has:
 *
 * GE1 Judge 1 total at position 4
 * GE1 Judge 2 total at position 10
 *
 * GE2 Judge 1 total at position 16
 * GE2 Judge 2 total at position 22
 *
 * GE total at position 24
 *
 * This is very different from the standard-panel
 * layout and allows us to distinguish the two.
 */
function looksLikeDoublePanel(
  values
) {
  if (
    !Array.isArray(values)
    || values.length < 69
  ) {
    return false;
  }

  return (
    /*
     * GE1 J1
     */
    parseTotal(
      values[4],
      20
    )

    /*
     * GE1 J2
     */
    && parseTotal(
      values[10],
      20
    )

    /*
     * GE2 J1
     */
    && parseTotal(
      values[16],
      20
    )

    /*
     * GE2 J2
     */
    && parseTotal(
      values[22],
      20
    )

    /*
     * GE total
     */
    && parseTotal(
      values[24],
      40
    )

    /*
     * VP total
     */
    && parseTotal(
      values[30],
      20
    )

    /*
     * VA total
     */
    && parseTotal(
      values[36],
      20
    )

    /*
     * CG total
     */
    && parseTotal(
      values[42],
      20
    )

    /*
     * Visual total
     */
    && parseTotal(
      values[44],
      30
    )

    /*
     * Brass total
     */
    && parseTotal(
      values[50],
      20
    )

    /*
     * MA Judge 1 total
     */
    && parseTotal(
      values[56],
      20
    )

    /*
     * MA Judge 2 total
     */
    && parseTotal(
      values[62],
      20
    )

    /*
     * Percussion total
     */
    && parseTotal(
      values[68],
      20
    )
  );
}


/*
 * =====================================================
 * STANDARD PANEL
 * =====================================================
 */

function parseStandardScores(
  values,
  corpsName
) {
  if (
    values.length < 49
  ) {
    throw pasteError(
      `${corpsName}: expected at least 49 standard-panel recap cells after the corps name, but found ${values.length}.`
    );
  }

  return STANDARD_SCORE_LAYOUT.map(
    ({
      captionCode,
      firstIndex,
      secondIndex
    }) => {
      const firstScore =
        parseScore(
          values[firstIndex],
          corpsName,
          captionCode,
          'first score'
        );

      const secondScore =
        parseScore(
          values[secondIndex],
          corpsName,
          captionCode,
          'second score'
        );

      return {
        captionCode,

        /*
         * Official fantasy values.
         */
        firstScore,

        secondScore,

        /*
         * Raw judge information.
         */
        judges: [
          {
            judgeNumber: 1,
            firstScore,
            secondScore
          }
        ]
      };
    }
  );
}


/*
 * =====================================================
 * DOUBLE PANEL
 * =====================================================
 */

function parseDoubleScores(
  values,
  corpsName
) {
  if (
    values.length < 69
  ) {
    throw pasteError(
      `${corpsName}: expected at least 69 double-panel recap cells after the corps name, but found ${values.length}.`
    );
  }

  return DOUBLE_SCORE_LAYOUT.map(
    (entry) => {
      /*
       * Read every individual judge first.
       */
      const judges =
        entry.judges.map(
          (
            judge,
            judgeIndex
          ) => ({
            judgeNumber:
              judgeIndex + 1,

            firstScore:
              parseScore(
                values[
                  judge.firstIndex
                ],
                corpsName,
                entry.captionCode,
                `Judge ${judgeIndex + 1} first score`
              ),

            secondScore:
              parseScore(
                values[
                  judge.secondIndex
                ],
                corpsName,
                entry.captionCode,
                `Judge ${judgeIndex + 1} second score`
              )
          })
        );


      /*
       * Single-judge captions just use their
       * original scores.
       */
      let firstScore =
        judges[0].firstScore;

      let secondScore =
        judges[0].secondScore;


      /*
       * If this caption has two judges:
       *
       * average the FIRST scores together
       *
       * and separately:
       *
       * average the SECOND scores together.
       *
       *
       * Example:
       *
       * GE2 Judge 1
       * Rep  = 9.800
       * Perf = 9.800
       *
       * GE2 Judge 2
       * Rep  = 9.900
       * Perf = 9.900
       *
       *
       * Official:
       *
       * Rep:
       * (9.800 + 9.900) / 2
       * = 9.850
       *
       * Perf:
       * (9.800 + 9.900) / 2
       * = 9.850
       */
      if (
        judges.length === 2
      ) {
        firstScore =
          averageTwo(
            judges[0].firstScore,
            judges[1].firstScore
          );

        secondScore =
          averageTwo(
            judges[0].secondScore,
            judges[1].secondScore
          );
      }


      return {
        captionCode:
          entry.captionCode,

        /*
         * These are the values the fantasy
         * league should use.
         */
        firstScore,

        secondScore,

        /*
         * Keep the original judge scores as well.
         */
        judges
      };
    }
  );
}


/*
 * =====================================================
 * COMPLETE PASTE PARSER
 * =====================================================
 */

function parseRecapPaste(
  rawText,
  corpsRows
) {
  const lines =
    splitPasteLines(
      rawText
    );


  if (
    !lines.length
  ) {
    throw pasteError(
      'Paste recap scores before importing.'
    );
  }


  const corpsByName =
    new Map(
      corpsRows.map(
        (corps) => [
          nameKey(
            corps.name
          ),

          corps
        ]
      )
    );


  const blocks = [];

  let currentBlock =
    null;


  /*
   * Break the paste into one block per corps.
   */
  for (
    const line
    of lines
  ) {
    const matchedCorps =
      corpsByName.get(
        nameKey(line)
      );


    if (
      matchedCorps
    ) {
      if (
        currentBlock
      ) {
        blocks.push(
          currentBlock
        );
      }


      currentBlock = {
        corps:
          matchedCorps,

        values:
          []
      };


      continue;
    }


    if (
      currentBlock
    ) {
      currentBlock.values.push(
        line
      );
    }
  }


  if (
    currentBlock
  ) {
    blocks.push(
      currentBlock
    );
  }


  if (
    !blocks.length
  ) {
    throw pasteError(
      'No known corps names were found. Begin the pasted recap with a corps name such as "Bluecoats".'
    );
  }


  const seenCorps =
    new Set();


  /*
   * All corps within the same pasted recap should
   * have the same judging-panel structure.
   */
  let detectedPanelType =
    null;


  return blocks.map(
    ({
      corps,
      values
    }) => {
      if (
        seenCorps.has(
          corps.id
        )
      ) {
        throw pasteError(
          `${corps.name} appears more than once in the pasted recap.`
        );
      }


      seenCorps.add(
        corps.id
      );


      const panelType =
        looksLikeDoublePanel(
          values
        )
          ? 'DOUBLE'
          : 'STANDARD';


      /*
       * Prevent a corrupted paste where one corps
       * looks standard and another looks double.
       */
      if (
        detectedPanelType
        && detectedPanelType
          !== panelType
      ) {
        throw pasteError(
          `The pasted recap mixes ${detectedPanelType.toLowerCase()} and ${panelType.toLowerCase()} panel layouts. Paste one complete recap format at a time.`
        );
      }


      detectedPanelType =
        panelType;


      const scores =
        panelType === 'DOUBLE'
          ? parseDoubleScores(
              values,
              corps.name
            )
          : parseStandardScores(
              values,
              corps.name
            );


      return {
        corpsId:
          corps.id,

        corpsName:
          corps.name,

        /*
         * Lets admin.js know this was a
         * standard or double panel.
         */
        panelType,

        scores
      };
    }
  );
}


module.exports = {
  parseRecapPaste,

  /*
   * Old export kept for compatibility.
   */
  SCORE_LAYOUT,

  STANDARD_SCORE_LAYOUT,

  DOUBLE_SCORE_LAYOUT
};
