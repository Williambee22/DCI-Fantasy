const cheerio = require('cheerio');

const {
  query,
  withTransaction
} = require('../db');

const config = require('../config');

const {
  slugify
} = require('../utils');

const dciParsing = require('./dciParsing');

const {
  parseNumbers,
  extractStandardRowScores,
  parseDateFromText
} = dciParsing;

/*
 * Once dciParsing.js is upgraded, it can export:
 *
 * extractDoubleRowScores()
 *
 * Until then, standard-panel imports will continue
 * working normally.
 */
const extractDoubleRowScores =
  typeof dciParsing.extractDoubleRowScores === 'function'
    ? dciParsing.extractDoubleRowScores
    : null;


/*
 * These are the only captions that use two judges
 * on the double-panel format.
 */
const DOUBLE_JUDGE_CAPTIONS = new Set([
  'GE1',
  'GE2',
  'MA'
]);


/*
 * =====================================================
 * IMPORT PERMISSION
 * =====================================================
 */

function assertImportAllowed() {
  if (
    !config.dciImportEnabled
    || !config.dciPermissionConfirmed
  ) {
    throw new Error(
      'DCI import is disabled. Set DCI_IMPORT_ENABLED=true and DCI_PERMISSION_CONFIRMED=true only after receiving permission to reuse DCI score reports.'
    );
  }

  if (!config.dciContactEmail) {
    throw new Error(
      'DCI_CONTACT_EMAIL is required for an identifiable importer user agent.'
    );
  }
}


/*
 * =====================================================
 * FETCH HTML
 * =====================================================
 */

async function fetchHtml(url) {
  const response = await fetch(
    url,
    {
      headers: {
        'user-agent':
          `CorpsDraft/1.0 score-import (${config.dciContactEmail})`,

        accept:
          'text/html,application/xhtml+xml'
      },

      signal:
        AbortSignal.timeout(20_000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `DCI returned HTTP ${response.status} for ${url}`
    );
  }

  return response.text();
}


/*
 * =====================================================
 * SCORE HELPERS
 * =====================================================
 */

/*
 * Average duplicate judge scores separately.
 *
 * Example:
 *
 * Judge 1 Content = 9.800
 * Judge 2 Content = 9.700
 *
 * official Content = 9.750
 *
 *
 * Judge 1 Achievement = 9.900
 * Judge 2 Achievement = 9.850
 *
 * official Achievement = 9.875
 */
function averageAvailable(
  first,
  second
) {
  const a =
    first == null
      ? null
      : Number(first);

  const b =
    second == null
      ? null
      : Number(second);

  if (
    a != null
    && Number.isFinite(a)
    && b != null
    && Number.isFinite(b)
  ) {
    return (
      a + b
    ) / 2;
  }

  if (
    a != null
    && Number.isFinite(a)
  ) {
    return a;
  }

  if (
    b != null
    && Number.isFinite(b)
  ) {
    return b;
  }

  return null;
}


function validateScore(value) {
  return (
    value == null
    || (
      Number.isFinite(Number(value))
      && Number(value) >= 0
      && Number(value) <= 10
    )
  );
}


/*
 * Convert whatever the parser returns into a common
 * structure.
 *
 * STANDARD:
 *
 * {
 *   first: 9.800,
 *   second: 9.900
 * }
 *
 *
 * DOUBLE:
 *
 * {
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
 */
function normalizeCaptionScore(
  captionCode,
  scoreData,
  panelType
) {
  if (!scoreData) {
    return {
      judges: [],
      first: null,
      second: null
    };
  }

  /*
   * New double-panel parser structure.
   */
  if (
    Array.isArray(scoreData.judges)
  ) {
    const judges =
      scoreData.judges
        .slice(0, 2)
        .map((judge) => ({
          first:
            judge?.first == null
              ? null
              : Number(judge.first),

          second:
            judge?.second == null
              ? null
              : Number(judge.second)
        }));

    const judge1 =
      judges[0] || {};

    const judge2 =
      judges[1] || {};

    const shouldAverage =
      panelType === 'DOUBLE'
      && DOUBLE_JUDGE_CAPTIONS.has(
        captionCode
      );

    return {
      judges,

      first:
        shouldAverage
          ? averageAvailable(
              judge1.first,
              judge2.first
            )
          : (
              judge1.first
              ?? null
            ),

      second:
        shouldAverage
          ? averageAvailable(
              judge1.second,
              judge2.second
            )
          : (
              judge1.second
              ?? null
            )
    };
  }

  /*
   * Alternative parser structure:
   *
   * judge1: {...}
   * judge2: {...}
   */
  if (
    scoreData.judge1
    || scoreData.judge2
  ) {
    const judge1 =
      scoreData.judge1 || {};

    const judge2 =
      scoreData.judge2 || {};

    const judges = [
      {
        first:
          judge1.first == null
            ? null
            : Number(judge1.first),

        second:
          judge1.second == null
            ? null
            : Number(judge1.second)
      }
    ];

    if (
      scoreData.judge2
    ) {
      judges.push({
        first:
          judge2.first == null
            ? null
            : Number(judge2.first),

        second:
          judge2.second == null
            ? null
            : Number(judge2.second)
      });
    }

    const shouldAverage =
      panelType === 'DOUBLE'
      && DOUBLE_JUDGE_CAPTIONS.has(
        captionCode
      );

    return {
      judges,

      first:
        shouldAverage
          ? averageAvailable(
              judge1.first,
              judge2.first
            )
          : (
              judge1.first
              ?? null
            ),

      second:
        shouldAverage
          ? averageAvailable(
              judge1.second,
              judge2.second
            )
          : (
              judge1.second
              ?? null
            )
    };
  }

  /*
   * Current standard-panel parser structure.
   */
  const first =
    scoreData.first == null
      ? null
      : Number(scoreData.first);

  const second =
    scoreData.second == null
      ? null
      : Number(scoreData.second);

  return {
    judges: [
      {
        first,
        second
      }
    ],

    first,
    second
  };
}


/*
 * Determine whether the parsed recap contains
 * duplicate judges.
 */
function detectPanelType(rows) {
  for (const row of rows) {
    for (
      const [
        captionCode,
        scoreData
      ]
      of Object.entries(
        row.scores || {}
      )
    ) {
      if (
        !DOUBLE_JUDGE_CAPTIONS.has(
          captionCode
        )
      ) {
        continue;
      }

      if (
        Array.isArray(
          scoreData?.judges
        )
        && scoreData.judges.length > 1
      ) {
        return 'DOUBLE';
      }

      if (
        scoreData?.judge2
      ) {
        return 'DOUBLE';
      }
    }
  }

  return 'STANDARD';
}


/*
 * =====================================================
 * PARSE DCI RECAP HTML
 * =====================================================
 */

function parseRecapHtml(
  html,
  sourceUrl,
  yearHint = config.dciSourceYear
) {
  const $ =
    cheerio.load(html);

  const headingCandidates =
    $('h1')
      .map(
        (_, element) =>
          $(element)
            .text()
            .trim()
      )
      .get()
      .filter(Boolean);

  const eventName =
    headingCandidates.at(-1)
    || 'Imported DCI Event';

  const pageText =
    $('body')
      .text()
      .replace(
        /\s+/g,
        ' '
      );

  const eventDate =
    parseDateFromText(
      pageText,
      yearHint
    );

  const rows = [];


  $('table tr').each(
    (_, tr) => {
      const cells =
        $(tr)
          .find(
            'th, td'
          )
          .map(
            (__, cell) =>
              $(cell)
                .text()
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim()
          )
          .get();

      if (
        cells.length < 2
      ) {
        return;
      }

      const corpsName =
        cells[0];

      if (
        !corpsName
        || /corps|place/i.test(
          corpsName
        )
      ) {
        return;
      }

      const numbers =
        parseNumbers(
          cells
            .slice(1)
            .join(' ')
        );

      /*
       * Try double-panel parsing first if the upgraded
       * parser exists.
       */
      let scores = null;

      if (
        extractDoubleRowScores
      ) {
        try {
          scores =
            extractDoubleRowScores(
              numbers,
              cells
            );
        } catch (_error) {
          scores = null;
        }
      }

      /*
       * Fall back to the existing standard parser.
       */
      if (!scores) {
        scores =
          extractStandardRowScores(
            numbers
          );
      }

      if (scores) {
        rows.push({
          corpsName,
          scores
        });
      }
    }
  );


  if (!rows.length) {
    throw new Error(
      'No DCI recap rows were recognized. Use manual score entry or update dciParsing.js for the current recap table structure.'
    );
  }


  const panelType =
    detectPanelType(
      rows
    );


  return {
    name:
      eventName,

    slug:
      slugify(
        `${eventDate}-${eventName}`
      ),

    eventDate,

    location:
      null,

    sourceUrl,

    panelType,

    rows
  };
}


/*
 * =====================================================
 * SAVE RAW JUDGE SCORE
 * =====================================================
 */

async function upsertJudgeScore(
  client,
  eventId,
  corpsId,
  captionCode,
  judgeNumber,
  first,
  second
) {
  if (
    first == null
    && second == null
  ) {
    await client.query(`
      DELETE FROM score_panels

      WHERE event_id = $1
        AND corps_id = $2
        AND caption_code = $3
        AND judge_number = $4
    `, [
      eventId,
      corpsId,
      captionCode,
      judgeNumber
    ]);

    return;
  }


  if (
    !validateScore(first)
    || !validateScore(second)
  ) {
    throw new Error(
      `Invalid ${captionCode} judge score. Scores must be between 0.000 and 10.000.`
    );
  }


  await client.query(`
    INSERT INTO score_panels (
      event_id,
      corps_id,
      caption_code,
      judge_number,
      first_score,
      second_score,
      updated_at
    )

    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      NOW()
    )

    ON CONFLICT (
      event_id,
      corps_id,
      caption_code,
      judge_number
    )

    DO UPDATE SET
      first_score =
        EXCLUDED.first_score,

      second_score =
        EXCLUDED.second_score,

      updated_at =
        NOW()
  `, [
    eventId,
    corpsId,
    captionCode,
    judgeNumber,
    first,
    second
  ]);
}


/*
 * =====================================================
 * SAVE OFFICIAL AVERAGED SCORE
 * =====================================================
 */

async function upsertOfficialScore(
  client,
  eventId,
  corpsId,
  captionCode,
  first,
  second
) {
  if (
    first == null
    && second == null
  ) {
    await client.query(`
      DELETE FROM scores

      WHERE event_id = $1
        AND corps_id = $2
        AND caption_code = $3
    `, [
      eventId,
      corpsId,
      captionCode
    ]);

    return;
  }


  if (
    !validateScore(first)
    || !validateScore(second)
  ) {
    throw new Error(
      `Invalid official ${captionCode} score. Scores must be between 0.000 and 10.000.`
    );
  }


  await client.query(`
    INSERT INTO scores (
      event_id,
      corps_id,
      caption_code,
      first_score,
      second_score,
      updated_at
    )

    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      NOW()
    )

    ON CONFLICT (
      event_id,
      corps_id,
      caption_code
    )

    DO UPDATE SET
      first_score =
        EXCLUDED.first_score,

      second_score =
        EXCLUDED.second_score,

      updated_at =
        NOW()
  `, [
    eventId,
    corpsId,
    captionCode,
    first,
    second
  ]);
}


/*
 * =====================================================
 * INSERT / UPDATE IMPORTED EVENT
 * =====================================================
 */

async function upsertImportedEvent(
  parsed
) {
  return withTransaction(
    async (client) => {
      const panelType =
        parsed.panelType === 'DOUBLE'
          ? 'DOUBLE'
          : 'STANDARD';


      const eventResult =
        await client.query(`
          INSERT INTO events (
            name,
            slug,
            event_date,
            location,
            source_url,
            source_kind,
            panel_type,
            finalized
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'DCI_AUTHORIZED_IMPORT',
            $6,
            TRUE
          )

          ON CONFLICT (slug)

          DO UPDATE SET
            name =
              EXCLUDED.name,

            event_date =
              EXCLUDED.event_date,

            location =
              EXCLUDED.location,

            source_url =
              EXCLUDED.source_url,

            source_kind =
              EXCLUDED.source_kind,

            panel_type =
              EXCLUDED.panel_type,

            updated_at =
              NOW()

          RETURNING id
        `, [
          parsed.name,
          parsed.slug,
          parsed.eventDate,
          parsed.location,
          parsed.sourceUrl,
          panelType
        ]);


      const eventId =
        eventResult.rows[0].id;


      let scoreCount = 0;

      let judgeScoreCount = 0;


      for (
        const row
        of parsed.rows
      ) {
        const corpsSlug =
          slugify(
            row.corpsName
          );


        const corpsResult =
          await client.query(`
            INSERT INTO corps (
              name,
              slug,
              active
            )

            VALUES (
              $1,
              $2,
              TRUE
            )

            ON CONFLICT (slug)

            DO UPDATE SET
              name =
                EXCLUDED.name

            RETURNING id
          `, [
            row.corpsName,
            corpsSlug
          ]);


        const corpsId =
          corpsResult.rows[0].id;


        for (
          const [
            captionCode,
            rawScoreData
          ]
          of Object.entries(
            row.scores
          )
        ) {
          const normalized =
            normalizeCaptionScore(
              captionCode,
              rawScoreData,
              panelType
            );


          /*
           * Remove existing raw judge scores for this
           * caption before replacing the imported recap.
           *
           * This prevents stale Judge 2 data if a recap
           * changes from DOUBLE to STANDARD.
           */
          await client.query(`
            DELETE FROM score_panels

            WHERE event_id = $1
              AND corps_id = $2
              AND caption_code = $3
          `, [
            eventId,
            corpsId,
            captionCode
          ]);


          /*
           * Store every individual judge.
           */
          for (
            let judgeIndex = 0;
            judgeIndex <
              normalized.judges.length;
            judgeIndex += 1
          ) {
            /*
             * Judge 2 is only valid on GE1, GE2,
             * and MA when the event is DOUBLE.
             */
            if (
              judgeIndex === 1
              && (
                panelType !== 'DOUBLE'
                || !DOUBLE_JUDGE_CAPTIONS.has(
                  captionCode
                )
              )
            ) {
              continue;
            }


            const judge =
              normalized.judges[
                judgeIndex
              ];


            await upsertJudgeScore(
              client,
              eventId,
              corpsId,
              captionCode,
              judgeIndex + 1,
              judge.first,
              judge.second
            );


            if (
              judge.first != null
              || judge.second != null
            ) {
              judgeScoreCount += 1;
            }
          }


          /*
           * Store the official fantasy values.
           *
           * If two judges exist:
           *
           * first_score =
           * average of BOTH first/content scores
           *
           * second_score =
           * average of BOTH second/achievement scores
           */
          await upsertOfficialScore(
            client,
            eventId,
            corpsId,
            captionCode,
            normalized.first,
            normalized.second
          );


          if (
            normalized.first != null
            || normalized.second != null
          ) {
            scoreCount += 1;
          }
        }
      }


      return {
        eventId,
        scoreCount,
        judgeScoreCount,
        panelType
      };
    }
  );
}


/*
 * =====================================================
 * IMPORT ONE DCI RECAP URL
 * =====================================================
 */

async function importRecapUrl(
  url
) {
  assertImportAllowed();


  if (
    !/^https:\/\/(?:www\.)?dci\.org\/scores\/recap\//i.test(
      url
    )
  ) {
    throw new Error(
      'Only official dci.org recap URLs are accepted by this importer.'
    );
  }


  const html =
    await fetchHtml(
      url
    );


  const parsed =
    parseRecapHtml(
      html,
      url
    );


  const result =
    await upsertImportedEvent(
      parsed
    );


  await query(`
    INSERT INTO sync_runs (
      source,
      status,
      message
    )

    VALUES (
      'DCI',
      'SUCCESS',
      $1
    )
  `, [
    `Imported ${parsed.name}: ${result.scoreCount} official caption rows, ${result.judgeScoreCount} judge rows, ${result.panelType} panel`
  ]);


  return {
    ...parsed,
    ...result
  };
}


/*
 * =====================================================
 * DISCOVER DCI RECAP URLS
 * =====================================================
 */

async function discoverRecapUrls(
  year =
    config.dciSourceYear
) {
  assertImportAllowed();


  const html =
    await fetchHtml(
      'https://www.dci.org/scores/'
    );


  const $ =
    cheerio.load(
      html
    );


  const urls =
    new Set();


  $(
    `a[href*="/scores/recap/${year}-"]`
  ).each(
    (_, link) => {
      const href =
        $(link).attr(
          'href'
        );

      if (!href) {
        return;
      }


      urls.add(
        new URL(
          href,
          'https://www.dci.org'
        ).href
      );
    }
  );


  return [
    ...urls
  ];
}


/*
 * =====================================================
 * SYNC DISCOVERED RECAPS
 * =====================================================
 */

async function syncDiscoveredRecaps() {
  const urls =
    await discoverRecapUrls();


  const results = [];


  for (
    const url
    of urls.slice(
      0,
      50
    )
  ) {
    try {
      results.push({
        url,

        ok:
          true,

        result:
          await importRecapUrl(
            url
          )
      });
    } catch (error) {
      results.push({
        url,

        ok:
          false,

        error:
          error.message
      });
    }
  }


  return results;
}


/*
 * =====================================================
 * EXPORTS
 * =====================================================
 */

module.exports = {
  parseNumbers,
  extractStandardRowScores,
  parseRecapHtml,
  upsertImportedEvent,
  importRecapUrl,
  discoverRecapUrls,
  syncDiscoveredRecaps,
  assertImportAllowed
};
