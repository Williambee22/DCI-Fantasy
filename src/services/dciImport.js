/*
 * =====================================================
 * STANDARD PANEL POSITIONS
 * =====================================================
 *
 * These indexes are based on the numeric values
 * extracted from a normal DCI recap row.
 *
 * Placement numbers and caption totals are included
 * in the number array, which is why the indexes jump.
 *
 * Example:
 *
 * GE1
 * Content       index 0
 * placement     index 1
 * Achievement   index 2
 * placement     index 3
 * total         index 4
 * placement     index 5
 */
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


/*
 * =====================================================
 * DOUBLE PANEL POSITIONS
 * =====================================================
 *
 * Double-panel structure:
 *
 * GE1 Judge 1
 * GE1 Judge 2
 *
 * GE2 Judge 1
 * GE2 Judge 2
 *
 * GE Total
 *
 * VP
 * VA
 * CG
 * Visual Total
 *
 * Brass
 *
 * MA Judge 1
 * MA Judge 2
 *
 * Percussion
 * Music Total
 *
 * Overall Total
 *
 *
 * Using your Bluecoats example:
 *
 * GE1 J1:
 * 9.800
 * 9.900
 *
 * GE1 J2:
 * 9.800
 * 9.900
 *
 * GE2 J1:
 * 9.800
 * 9.800
 *
 * GE2 J2:
 * 9.900
 * 9.900
 *
 * etc.
 */
const DOUBLE_POSITIONS = {
  GE1: {
    judge1: [0, 2],
    judge2: [6, 8]
  },

  GE2: {
    judge1: [12, 14],
    judge2: [18, 20]
  },

  VP: {
    judge1: [26, 28]
  },

  VA: {
    judge1: [32, 34]
  },

  CG: {
    judge1: [38, 40]
  },

  BRASS: {
    judge1: [46, 48]
  },

  MA: {
    judge1: [52, 54],
    judge2: [58, 60]
  },

  PERC: {
    judge1: [64, 66]
  }
};


/*
 * Useful positions for validating that a row really
 * looks like the double-panel format.
 */
const DOUBLE_TOTAL_POSITIONS = {
  GE: 24,
  VISUAL: 44,
  MUSIC: 70,
  OVERALL: 72
};


/*
 * =====================================================
 * NUMBER PARSING
 * =====================================================
 */

function parseNumbers(text) {
  return (
    String(text)
      .match(/\b\d+(?:\.\d+)?\b/g)
    || []
  ).map(Number);
}


/*
 * Content/Achievement scores must be between
 * 0.000 and 10.000.
 */
function validSubcaption(value) {
  return (
    Number.isFinite(value)
    && value >= 0
    && value <= 10
  );
}


/*
 * Caption totals such as 19.700.
 */
function validCaptionTotal(value) {
  return (
    Number.isFinite(value)
    && value >= 0
    && value <= 20
  );
}


/*
 * Section totals:
 *
 * GE     <= 40
 * Visual <= 30
 * Music  <= 30
 */
function validSectionTotal(
  value,
  maximum
) {
  return (
    Number.isFinite(value)
    && value >= 0
    && value <= maximum
  );
}


/*
 * Overall score.
 */
function validOverall(value) {
  return (
    Number.isFinite(value)
    && value >= 0
    && value <= 100
  );
}


/*
 * =====================================================
 * STANDARD PANEL PARSER
 * =====================================================
 */

function extractStandardRowScores(numbers) {
  if (
    !Array.isArray(numbers)
    || numbers.length < 49
  ) {
    return null;
  }

  const output = {};

  for (
    const [
      caption,
      [
        firstIndex,
        secondIndex
      ]
    ]
    of Object.entries(
      STANDARD_POSITIONS
    )
  ) {
    const first =
      numbers[firstIndex];

    const second =
      numbers[secondIndex];

    if (
      !validSubcaption(first)
      || !validSubcaption(second)
    ) {
      return null;
    }

    output[caption] = {
      first,
      second
    };
  }

  return output;
}


/*
 * =====================================================
 * DOUBLE PANEL PARSER
 * =====================================================
 *
 * This intentionally returns the duplicate judges
 * instead of averaging them here.
 *
 * dciImport.js receives:
 *
 * GE1: {
 *   judges: [
 *     {
 *       first: 9.800,
 *       second: 9.900
 *     },
 *     {
 *       first: 9.700,
 *       second: 9.850
 *     }
 *   ]
 * }
 *
 * dciImport.js then calculates:
 *
 * Content:
 * (9.800 + 9.700) / 2
 * = 9.750
 *
 * Achievement:
 * (9.900 + 9.850) / 2
 * = 9.875
 */
function extractDoubleRowScores(numbers) {
  /*
   * Your example reaches at least index 72 before
   * the final score, so a standard row should never
   * accidentally be interpreted as a double row.
   */
  if (
    !Array.isArray(numbers)
    || numbers.length < 73
  ) {
    return null;
  }


  /*
   * Validate the major totals as an additional
   * safeguard against interpreting another table
   * format as this double-panel format.
   */
  const geTotal =
    numbers[
      DOUBLE_TOTAL_POSITIONS.GE
    ];

  const visualTotal =
    numbers[
      DOUBLE_TOTAL_POSITIONS.VISUAL
    ];

  const musicTotal =
    numbers[
      DOUBLE_TOTAL_POSITIONS.MUSIC
    ];

  const overallTotal =
    numbers[
      DOUBLE_TOTAL_POSITIONS.OVERALL
    ];


  if (
    !validSectionTotal(
      geTotal,
      40
    )
    || !validSectionTotal(
      visualTotal,
      30
    )
    || !validSectionTotal(
      musicTotal,
      30
    )
    || !validOverall(
      overallTotal
    )
  ) {
    return null;
  }


  const output = {};


  /*
   * =================================================
   * GENERAL EFFECT 1
   * =================================================
   */

  const ge1Judge1First =
    numbers[
      DOUBLE_POSITIONS
        .GE1
        .judge1[0]
    ];

  const ge1Judge1Second =
    numbers[
      DOUBLE_POSITIONS
        .GE1
        .judge1[1]
    ];

  const ge1Judge2First =
    numbers[
      DOUBLE_POSITIONS
        .GE1
        .judge2[0]
    ];

  const ge1Judge2Second =
    numbers[
      DOUBLE_POSITIONS
        .GE1
        .judge2[1]
    ];


  if (
    !validSubcaption(
      ge1Judge1First
    )
    || !validSubcaption(
      ge1Judge1Second
    )
    || !validSubcaption(
      ge1Judge2First
    )
    || !validSubcaption(
      ge1Judge2Second
    )
  ) {
    return null;
  }


  output.GE1 = {
    judges: [
      {
        first:
          ge1Judge1First,

        second:
          ge1Judge1Second
      },

      {
        first:
          ge1Judge2First,

        second:
          ge1Judge2Second
      }
    ]
  };


  /*
   * =================================================
   * GENERAL EFFECT 2
   * =================================================
   */

  const ge2Judge1First =
    numbers[
      DOUBLE_POSITIONS
        .GE2
        .judge1[0]
    ];

  const ge2Judge1Second =
    numbers[
      DOUBLE_POSITIONS
        .GE2
        .judge1[1]
    ];

  const ge2Judge2First =
    numbers[
      DOUBLE_POSITIONS
        .GE2
        .judge2[0]
    ];

  const ge2Judge2Second =
    numbers[
      DOUBLE_POSITIONS
        .GE2
        .judge2[1]
    ];


  if (
    !validSubcaption(
      ge2Judge1First
    )
    || !validSubcaption(
      ge2Judge1Second
    )
    || !validSubcaption(
      ge2Judge2First
    )
    || !validSubcaption(
      ge2Judge2Second
    )
  ) {
    return null;
  }


  output.GE2 = {
    judges: [
      {
        first:
          ge2Judge1First,

        second:
          ge2Judge1Second
      },

      {
        first:
          ge2Judge2First,

        second:
          ge2Judge2Second
      }
    ]
  };


  /*
   * =================================================
   * VISUAL PROFICIENCY
   * =================================================
   */

  const vpFirst =
    numbers[
      DOUBLE_POSITIONS
        .VP
        .judge1[0]
    ];

  const vpSecond =
    numbers[
      DOUBLE_POSITIONS
        .VP
        .judge1[1]
    ];


  if (
    !validSubcaption(vpFirst)
    || !validSubcaption(vpSecond)
  ) {
    return null;
  }


  output.VP = {
    first:
      vpFirst,

    second:
      vpSecond
  };


  /*
   * =================================================
   * VISUAL ANALYSIS
   * =================================================
   */

  const vaFirst =
    numbers[
      DOUBLE_POSITIONS
        .VA
        .judge1[0]
    ];

  const vaSecond =
    numbers[
      DOUBLE_POSITIONS
        .VA
        .judge1[1]
    ];


  if (
    !validSubcaption(vaFirst)
    || !validSubcaption(vaSecond)
  ) {
    return null;
  }


  output.VA = {
    first:
      vaFirst,

    second:
      vaSecond
  };


  /*
   * =================================================
   * COLOR GUARD
   * =================================================
   */

  const cgFirst =
    numbers[
      DOUBLE_POSITIONS
        .CG
        .judge1[0]
    ];

  const cgSecond =
    numbers[
      DOUBLE_POSITIONS
        .CG
        .judge1[1]
    ];


  if (
    !validSubcaption(cgFirst)
    || !validSubcaption(cgSecond)
  ) {
    return null;
  }


  output.CG = {
    first:
      cgFirst,

    second:
      cgSecond
  };


  /*
   * =================================================
   * BRASS
   * =================================================
   */

  const brassFirst =
    numbers[
      DOUBLE_POSITIONS
        .BRASS
        .judge1[0]
    ];

  const brassSecond =
    numbers[
      DOUBLE_POSITIONS
        .BRASS
        .judge1[1]
    ];


  if (
    !validSubcaption(
      brassFirst
    )
    || !validSubcaption(
      brassSecond
    )
  ) {
    return null;
  }


  output.BRASS = {
    first:
      brassFirst,

    second:
      brassSecond
  };


  /*
   * =================================================
   * MUSIC ANALYSIS
   * =================================================
   */

  const maJudge1First =
    numbers[
      DOUBLE_POSITIONS
        .MA
        .judge1[0]
    ];

  const maJudge1Second =
    numbers[
      DOUBLE_POSITIONS
        .MA
        .judge1[1]
    ];

  const maJudge2First =
    numbers[
      DOUBLE_POSITIONS
        .MA
        .judge2[0]
    ];

  const maJudge2Second =
    numbers[
      DOUBLE_POSITIONS
        .MA
        .judge2[1]
    ];


  if (
    !validSubcaption(
      maJudge1First
    )
    || !validSubcaption(
      maJudge1Second
    )
    || !validSubcaption(
      maJudge2First
    )
    || !validSubcaption(
      maJudge2Second
    )
  ) {
    return null;
  }


  output.MA = {
    judges: [
      {
        first:
          maJudge1First,

        second:
          maJudge1Second
      },

      {
        first:
          maJudge2First,

        second:
          maJudge2Second
      }
    ]
  };


  /*
   * =================================================
   * PERCUSSION
   * =================================================
   */

  const percFirst =
    numbers[
      DOUBLE_POSITIONS
        .PERC
        .judge1[0]
    ];

  const percSecond =
    numbers[
      DOUBLE_POSITIONS
        .PERC
        .judge1[1]
    ];


  if (
    !validSubcaption(
      percFirst
    )
    || !validSubcaption(
      percSecond
    )
  ) {
    return null;
  }


  output.PERC = {
    first:
      percFirst,

    second:
      percSecond
  };


  return output;
}


/*
 * =====================================================
 * DATE PARSING
 * =====================================================
 */

function dateToIso(
  month,
  day,
  year
) {
  const date =
    new Date(
      `${month} ${day}, ${year} 12:00:00 UTC`
    );

  return Number.isNaN(
    date.valueOf()
  )
    ? null
    : date
        .toISOString()
        .slice(0, 10);
}


function parseDateFromText(
  text,
  yearHint
) {
  const source =
    String(text);


  /*
   * Example:
   *
   * August 7, 2026
   */
  const namedPattern =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/gi;


  const namedMatches = [
    ...source.matchAll(
      namedPattern
    )
  ]
    .map(
      (match) => ({
        year:
          Number(
            match[3]
          ),

        iso:
          dateToIso(
            match[1],
            match[2],
            match[3]
          )
      })
    )
    .filter(
      (item) =>
        item.iso
    );


  const matchingNamed =
    namedMatches.filter(
      (item) =>
        item.year
        === Number(yearHint)
    );


  if (
    matchingNamed.length
  ) {
    return matchingNamed.at(-1).iso;
  }


  if (
    namedMatches.length
  ) {
    return namedMatches.at(-1).iso;
  }


  /*
   * Example:
   *
   * 08/07/2026
   */
  const numericPattern =
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;


  const numericMatches = [
    ...source.matchAll(
      numericPattern
    )
  ].map(
    (match) => ({
      year:
        Number(
          match[3]
        ),

      iso:
        `${match[3]}-${match[1].padStart(
          2,
          '0'
        )}-${match[2].padStart(
          2,
          '0'
        )}`
    })
  );


  const matchingNumeric =
    numericMatches.filter(
      (item) =>
        item.year
        === Number(yearHint)
    );


  if (
    matchingNumeric.length
  ) {
    return matchingNumeric.at(-1).iso;
  }


  if (
    numericMatches.length
  ) {
    return numericMatches.at(-1).iso;
  }


  return `${yearHint}-01-01`;
}


/*
 * =====================================================
 * EXPORTS
 * =====================================================
 */

module.exports = {
  STANDARD_POSITIONS,
  DOUBLE_POSITIONS,
  DOUBLE_TOTAL_POSITIONS,

  parseNumbers,

  extractStandardRowScores,
  extractDoubleRowScores,

  parseDateFromText
};
