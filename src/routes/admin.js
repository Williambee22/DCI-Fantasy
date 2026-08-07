const express = require('express');
const { query, withTransaction } = require('../db');
const {
  requireAdmin,
  flash
} = require('../middleware');
const {
  cleanText,
  slugify,
  asNumber,
  formatScore
} = require('../utils');
const config = require('../config');
const {
  importRecapUrl,
  syncDiscoveredRecaps
} = require('../services/dciImport');
const {
  parseRecapPaste
} = require('../services/recapPaste');

const router = express.Router();

router.use(requireAdmin);


/*
 * Captions that can have two judges during
 * a double-panel event.
 */
const DOUBLE_JUDGE_CAPTIONS = new Set([
  'GE1',
  'GE2',
  'MA'
]);


/*
 * Only two panel types are supported.
 */
function normalizePanelType(value) {
  return value === 'DOUBLE'
    ? 'DOUBLE'
    : 'STANDARD';
}


/*
 * If both judges have a score, average them.
 *
 * If only one judge currently has a score,
 * use that score.
 *
 * If neither judge has a score, return null.
 */
function averageAvailable(first, second) {
  if (
    first != null
    && second != null
  ) {
    return (
      Number(first)
      + Number(second)
    ) / 2;
  }

  if (first != null) {
    return Number(first);
  }

  if (second != null) {
    return Number(second);
  }

  return null;
}


/*
 * Every judge score must be between
 * 0.000 and 10.000.
 */
function validateScore(value) {
  return (
    value == null
    || (
      Number.isFinite(value)
      && value >= 0
      && value <= 10
    )
  );
}


/*
 * Supports both the new judge-level form:
 *
 * panel_scores[corps][caption][1][first]
 *
 * and the old form:
 *
 * scores[corps][caption][first]
 */
function normalizeJudgeSubmission(
  captionValues
) {
  if (
    !captionValues
    || typeof captionValues !== 'object'
  ) {
    return {
      1: {},
      2: {}
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(
      captionValues,
      'first'
    )
    || Object.prototype.hasOwnProperty.call(
      captionValues,
      'second'
    )
  ) {
    return {
      1: captionValues,
      2: {}
    };
  }

  return {
    1:
      captionValues[1]
      || captionValues['1']
      || {},

    2:
      captionValues[2]
      || captionValues['2']
      || {}
  };
}


/*
 * Save one individual judge's score.
 *
 * These are the raw judging-panel numbers.
 */
async function saveJudgeScore(
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

    return false;
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

  return true;
}


/*
 * Save the official fantasy score.
 *
 * The normal scores table contains the score
 * that fantasy leagues actually use.
 *
 * For a standard panel:
 *
 *   Judge 1 Content
 *   Judge 1 Achievement
 *
 * For a double panel:
 *
 *   Content =
 *   (J1 Content + J2 Content) / 2
 *
 *   Achievement =
 *   (J1 Achievement + J2 Achievement) / 2
 */
async function saveOfficialScore(
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

    return false;
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

  return true;
}


/*
 * Recalculate the official scores from the
 * individual judge scores.
 *
 * This is useful when an event is changed from:
 *
 * STANDARD -> DOUBLE
 *
 * or
 *
 * DOUBLE -> STANDARD
 */
async function rebuildOfficialScoresForEvent(
  client,
  eventId,
  panelType
) {
  const panelResult =
    await client.query(`
      SELECT
        corps_id,
        caption_code,
        judge_number,
        first_score,
        second_score

      FROM score_panels

      WHERE event_id = $1

      ORDER BY
        corps_id,
        caption_code,
        judge_number
    `, [
      eventId
    ]);

  const grouped = new Map();

  for (const row of panelResult.rows) {
    const key =
      `${row.corps_id}:${row.caption_code}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        corpsId: row.corps_id,
        captionCode: row.caption_code,
        judges: {}
      });
    }

    grouped.get(key)
      .judges[row.judge_number] = row;
  }

  for (const entry of grouped.values()) {
    const judge1 =
      entry.judges[1] || null;

    const judge2 =
      entry.judges[2] || null;

    const useTwoJudges =
      panelType === 'DOUBLE'
      && DOUBLE_JUDGE_CAPTIONS.has(
        entry.captionCode
      );

    const first =
      useTwoJudges
        ? averageAvailable(
            judge1?.first_score,
            judge2?.first_score
          )
        : (
            judge1?.first_score != null
              ? Number(
                  judge1.first_score
                )
              : null
          );

    const second =
      useTwoJudges
        ? averageAvailable(
            judge1?.second_score,
            judge2?.second_score
          )
        : (
            judge1?.second_score != null
              ? Number(
                  judge1.second_score
                )
              : null
          );

    await saveOfficialScore(
      client,
      eventId,
      entry.corpsId,
      entry.captionCode,
      first,
      second
    );
  }
}


/*
 * =====================================================
 * ADMIN HOME
 * =====================================================
 */

router.get(
  '/admin',
  async (req, res, next) => {
    try {
      const [
        events,
        corps,
        syncRuns,
        counts
      ] = await Promise.all([
        query(`
          SELECT
            e.*,
            COUNT(s.id)::int
              AS score_rows

          FROM events e

          LEFT JOIN scores s
            ON s.event_id = e.id

          GROUP BY e.id

          ORDER BY
            e.event_date DESC,
            e.name

          LIMIT 100
        `),

        query(`
          SELECT *
          FROM corps

          ORDER BY
            active DESC,
            name
        `),

        query(`
          SELECT *
          FROM sync_runs

          ORDER BY
            created_at DESC

          LIMIT 12
        `),

        query(`
          SELECT
            (
              SELECT COUNT(*)::int
              FROM users
            ) AS users,

            (
              SELECT COUNT(*)::int
              FROM leagues
            ) AS leagues,

            (
              SELECT COUNT(*)::int
              FROM draft_picks
            ) AS picks,

            (
              SELECT COUNT(*)::int
              FROM scores
            ) AS scores
        `)
      ]);

      res.render(
        'admin/index',
        {
          title: 'Head Admin',

          events:
            events.rows,

          corps:
            corps.rows,

          syncRuns:
            syncRuns.rows,

          counts:
            counts.rows[0],

          dciImportEnabled:
            config.dciImportEnabled
            && config.dciPermissionConfirmed
        }
      );
    } catch (error) {
      next(error);
    }
  }
);


/*
 * =====================================================
 * CORPS MANAGEMENT
 * =====================================================
 */

router.post(
  '/admin/corps',
  async (req, res, next) => {
    try {
      const name =
        cleanText(
          req.body.name,
          120
        );

      if (name.length < 2) {
        flash(
          req,
          'error',
          'Corps name must be at least 2 characters.'
        );

        return res.redirect(
          '/admin'
        );
      }

      await query(`
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
            EXCLUDED.name,

          active =
            TRUE
      `, [
        name,
        slugify(name)
      ]);

      flash(
        req,
        'success',
        `${name} is available in drafts and score entry.`
      );

      return res.redirect(
        '/admin'
      );
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  '/admin/corps/:corpsId/toggle',
  async (req, res, next) => {
    try {
      await query(`
        UPDATE corps

        SET active =
          NOT active

        WHERE id = $1
      `, [
        req.params.corpsId
      ]);

      flash(
        req,
        'success',
        'Corps availability updated.'
      );

      return res.redirect(
        '/admin'
      );
    } catch (error) {
      next(error);
    }
  }
);


/*
 * =====================================================
 * CREATE EVENT
 * =====================================================
 */

router.get(
  '/admin/events/new',
  (req, res) => {
    res.render(
      'admin/event-new',
      {
        title: 'Add Event',
        form: {}
      }
    );
  }
);


router.post(
  '/admin/events',
  async (req, res, next) => {
    try {
      const name =
        cleanText(
          req.body.name,
          160
        );

      const eventDate =
        String(
          req.body.event_date
          || ''
        );

      const location =
        cleanText(
          req.body.location,
          160
        )
        || null;

      const panelType =
        normalizePanelType(
          req.body.panel_type
        );

      if (
        name.length < 2
        || !/^\d{4}-\d{2}-\d{2}$/.test(
          eventDate
        )
      ) {
        return res
          .status(400)
          .render(
            'admin/event-new',
            {
              title:
                'Add Event',

              form: {
                name,
                event_date:
                  eventDate,
                location,
                panel_type:
                  panelType
              },

              error:
                'Enter an event name and valid date.'
            }
          );
      }

      const baseSlug =
        slugify(
          `${eventDate}-${name}`
        );

      let slug =
        baseSlug;

      let event;

      for (
        let attempt = 0;
        attempt < 10;
        attempt += 1
      ) {
        try {
          const result =
            await query(`
              INSERT INTO events (
                name,
                slug,
                event_date,
                location,
                source_kind,
                panel_type,
                finalized
              )

              VALUES (
                $1,
                $2,
                $3,
                $4,
                'MANUAL',
                $5,
                TRUE
              )

              RETURNING *
            `, [
              name,
              slug,
              eventDate,
              location,
              panelType
            ]);

          event =
            result.rows[0];

          break;
        } catch (error) {
          if (
            error.code !==
            '23505'
          ) {
            throw error;
          }

          slug =
            `${baseSlug}-${attempt + 2}`;
        }
      }

      if (!event) {
        throw new Error(
          'Could not create event with a unique slug.'
        );
      }

      return res.redirect(
        `/admin/events/${event.id}/edit`
      );
    } catch (error) {
      next(error);
    }
  }
);


/*
 * =====================================================
 * EDIT EVENT
 * =====================================================
 */

router.get(
  '/admin/events/:eventId/edit',
  async (req, res, next) => {
    try {
      const [
        eventResult,
        corpsResult,
        captionsResult,
        scoreResult,
        scorePanelResult
      ] = await Promise.all([
        query(`
          SELECT *
          FROM events

          WHERE id = $1
        `, [
          req.params.eventId
        ]),

        query(`
          SELECT *
          FROM corps

          WHERE active = TRUE

          ORDER BY name
        `),

        query(`
          SELECT *
          FROM captions

          ORDER BY sort_order
        `),

        query(`
          SELECT *
          FROM scores

          WHERE event_id = $1
        `, [
          req.params.eventId
        ]),

        query(`
          SELECT *
          FROM score_panels

          WHERE event_id = $1

          ORDER BY
            corps_id,
            caption_code,
            judge_number
        `, [
          req.params.eventId
        ])
      ]);

      const event =
        eventResult.rows[0];

      if (!event) {
        return res
          .status(404)
          .render(
            'error',
            {
              title:
                'Event not found',

              message:
                'That event does not exist.'
            }
          );
      }

      /*
       * Official fantasy scores.
       */
      const scoreMap = {};

      for (
        const score
        of scoreResult.rows
      ) {
        scoreMap[
          `${score.corps_id}:${score.caption_code}`
        ] = score;
      }

      /*
       * Raw individual judge scores.
       */
      const scorePanelMap = {};

      for (
        const score
        of scorePanelResult.rows
      ) {
        scorePanelMap[
          `${score.corps_id}:${score.caption_code}:${score.judge_number}`
        ] = score;
      }

      return res.render(
        'admin/event-edit',
        {
          title:
            `Scores: ${event.name}`,

          event,

          corps:
            corpsResult.rows,

          captions:
            captionsResult.rows,

          scoreMap,

          scorePanelMap,

          formatScore
        }
      );
    } catch (error) {
      next(error);
    }
  }
);


/*
 * =====================================================
 * EVENT DETAILS
 * =====================================================
 *
 * Both paths are supported because the old page used:
 *
 * /meta
 *
 * while the updated page uses:
 *
 * /details
 */

router.post(
  [
    '/admin/events/:eventId/meta',
    '/admin/events/:eventId/details'
  ],
  async (req, res, next) => {
    try {
      const name =
        cleanText(
          req.body.name,
          160
        );

      const eventDate =
        String(
          req.body.event_date
          || ''
        );

      const location =
        cleanText(
          req.body.location,
          160
        )
        || null;

      const finalized =
        req.body.finalized
        === 'on';

      const panelType =
        normalizePanelType(
          req.body.panel_type
        );

      if (
        name.length < 2
        || !/^\d{4}-\d{2}-\d{2}$/.test(
          eventDate
        )
      ) {
        flash(
          req,
          'error',
          'Event name and date are required.'
        );

        return res.redirect(
          `/admin/events/${req.params.eventId}/edit`
        );
      }

      await withTransaction(
        async (client) => {
          const updated =
            await client.query(`
              UPDATE events

              SET
                name = $1,
                event_date = $2,
                location = $3,
                finalized = $4,
                panel_type = $5,
                updated_at = NOW()

              WHERE id = $6

              RETURNING id
            `, [
              name,
              eventDate,
              location,
              finalized,
              panelType,
              req.params.eventId
            ]);

          if (
            !updated.rowCount
          ) {
            throw Object.assign(
              new Error(
                'That event does not exist.'
              ),
              {
                status: 404
              }
            );
          }

          /*
           * Changing STANDARD/DOUBLE immediately
           * recalculates the official scores.
           */
          await rebuildOfficialScoresForEvent(
            client,
            req.params.eventId,
            panelType
          );
        }
      );

      flash(
        req,
        'success',
        'Event details updated.'
      );

      return res.redirect(
        `/admin/events/${req.params.eventId}/edit`
      );
    } catch (error) {
      if (
        error.status === 404
      ) {
        return res
          .status(404)
          .render(
            'error',
            {
              title:
                'Event not found',

              message:
                error.message
            }
          );
      }

      next(error);
    }
  }
);


/*
 * =====================================================
 * MANUAL SCORE ENTRY
 * =====================================================
 */

router.post(
  '/admin/events/:eventId/scores',
  async (req, res, next) => {
    try {
      const eventResult =
        await query(`
          SELECT
            id,
            panel_type

          FROM events

          WHERE id = $1
        `, [
          req.params.eventId
        ]);

      if (
        !eventResult.rowCount
      ) {
        return res
          .status(404)
          .render(
            'error',
            {
              title:
                'Event not found',

              message:
                'That event does not exist.'
            }
          );
      }

      const event =
        eventResult.rows[0];

      const panelType =
        normalizePanelType(
          event.panel_type
        );

      /*
       * New event-edit form:
       *
       * panel_scores
       *   [corps]
       *   [caption]
       *   [judge]
       *   [first/second]
       *
       * Old "scores" form is still accepted.
       */
      const submitted =
        req.body.panel_scores
        || req.body.scores
        || {};

      let savedOfficialRows = 0;

      let savedJudgeRows = 0;

      await withTransaction(
        async (client) => {
          for (
            const [
              corpsId,
              captionValues
            ]
            of Object.entries(
              submitted
            )
          ) {
            for (
              const [
                captionCode,
                rawJudges
              ]
              of Object.entries(
                captionValues
                || {}
              )
            ) {
              const judges =
                normalizeJudgeSubmission(
                  rawJudges
                );

              const judge1First =
                asNumber(
                  judges[1]?.first
                );

              const judge1Second =
                asNumber(
                  judges[1]?.second
                );

              const judge2First =
                asNumber(
                  judges[2]?.first
                );

              const judge2Second =
                asNumber(
                  judges[2]?.second
                );

              if (
                !validateScore(
                  judge1First
                )
                || !validateScore(
                  judge1Second
                )
                || !validateScore(
                  judge2First
                )
                || !validateScore(
                  judge2Second
                )
              ) {
                throw Object.assign(
                  new Error(
                    'Scores must be between 0.000 and 10.000.'
                  ),
                  {
                    status: 400
                  }
                );
              }

              const useTwoJudges =
                panelType ===
                  'DOUBLE'
                && DOUBLE_JUDGE_CAPTIONS.has(
                  captionCode
                );

              /*
               * Save Judge 1.
               */
              const judge1Saved =
                await saveJudgeScore(
                  client,
                  req.params.eventId,
                  corpsId,
                  captionCode,
                  1,
                  judge1First,
                  judge1Second
                );

              if (judge1Saved) {
                savedJudgeRows += 1;
              }

              /*
               * Save Judge 2 only for:
               *
               * GE1
               * GE2
               * Music Analysis
               *
               * on DOUBLE panel events.
               */
              if (useTwoJudges) {
                const judge2Saved =
                  await saveJudgeScore(
                    client,
                    req.params.eventId,
                    corpsId,
                    captionCode,
                    2,
                    judge2First,
                    judge2Second
                  );

                if (judge2Saved) {
                  savedJudgeRows += 1;
                }
              } else {
                /*
                 * Remove stale Judge 2 data
                 * for captions that should
                 * only use one judge.
                 */
                await client.query(`
                  DELETE FROM score_panels

                  WHERE event_id = $1
                    AND corps_id = $2
                    AND caption_code = $3
                    AND judge_number = 2
                `, [
                  req.params.eventId,
                  corpsId,
                  captionCode
                ]);
              }


              /*
               * ======================================
               * OFFICIAL FANTASY SUBCAPTION SCORES
               * ======================================
               *
               * This is the critical part.
               *
               * If GE1 has two judges:
               *
               * Content =
               * (J1 Content + J2 Content) / 2
               *
               * Achievement =
               * (J1 Achievement + J2 Achievement) / 2
               *
               * They are averaged SEPARATELY.
               *
               * The same applies to GE2 and MA.
               */

              const officialFirst =
                useTwoJudges
                  ? averageAvailable(
                      judge1First,
                      judge2First
                    )
                  : judge1First;

              const officialSecond =
                useTwoJudges
                  ? averageAvailable(
                      judge1Second,
                      judge2Second
                    )
                  : judge1Second;

              const officialSaved =
                await saveOfficialScore(
                  client,
                  req.params.eventId,
                  corpsId,
                  captionCode,
                  officialFirst,
                  officialSecond
                );

              if (
                officialSaved
              ) {
                savedOfficialRows += 1;
              }
            }
          }
        }
      );

      flash(
        req,
        'success',
        `Saved ${savedOfficialRows} official caption score rows from ${savedJudgeRows} judge score rows. Every fantasy league now reflects the update.`
      );

      return res.redirect(
        `/admin/events/${req.params.eventId}/edit`
      );
    } catch (error) {
      if (
        error.status === 400
      ) {
        flash(
          req,
          'error',
          error.message
        );

        return res.redirect(
          `/admin/events/${req.params.eventId}/edit`
        );
      }

      next(error);
    }
  }
);


/*
 * =====================================================
 * PASTE RECAP
 * =====================================================
 *
 * Both the original route and updated route
 * are supported.
 */

router.post(
  [
    '/admin/events/:eventId/paste-scores',
    '/admin/events/:eventId/import-recap'
  ],
  async (req, res, next) => {
    try {
      const [
        eventResult,
        corpsResult
      ] = await Promise.all([
        query(`
          SELECT
            id,
            name,
            panel_type

          FROM events

          WHERE id = $1
        `, [
          req.params.eventId
        ]),

        query(`
          SELECT
            id,
            name

          FROM corps

          ORDER BY name
        `)
      ]);

      if (
        !eventResult.rowCount
      ) {
        return res
          .status(404)
          .render(
            'error',
            {
              title:
                'Event not found',

              message:
                'That event does not exist.'
            }
          );
      }

      const event =
        eventResult.rows[0];

      /*
       * recapPaste.js still needs to be upgraded
       * before it can safely understand the raw
       * Judge 1 / Judge 2 DCI layout.
       *
       * Blocking it here prevents incorrect fantasy
       * scores from being imported.
       */
      if (
        event.panel_type ===
        'DOUBLE'
      ) {
        flash(
          req,
          'error',
          'Double-panel pasted recaps require the updated recap parser. For now, enter Judge 1 and Judge 2 scores manually.'
        );

        return res.redirect(
          `/admin/events/${req.params.eventId}/edit`
        );
      }

      const parsedCorps =
        parseRecapPaste(
          req.body.recap_text,
          corpsResult.rows
        );

      let savedRows = 0;

      await withTransaction(
        async (client) => {
          for (
            const parsedCorpsEntry
            of parsedCorps
          ) {
            for (
              const score
              of parsedCorpsEntry.scores
            ) {
              if (
                !validateScore(
                  score.firstScore
                )
                || !validateScore(
                  score.secondScore
                )
              ) {
                throw Object.assign(
                  new Error(
                    'Scores must be between 0.000 and 10.000.'
                  ),
                  {
                    status: 400
                  }
                );
              }

              /*
               * Standard recap = Judge 1.
               */
              await saveJudgeScore(
                client,
                req.params.eventId,
                parsedCorpsEntry.corpsId,
                score.captionCode,
                1,
                score.firstScore,
                score.secondScore
              );

              await saveOfficialScore(
                client,
                req.params.eventId,
                parsedCorpsEntry.corpsId,
                score.captionCode,
                score.firstScore,
                score.secondScore
              );

              savedRows += 1;
            }
          }
        }
      );

      flash(
        req,
        'success',
        `Imported ${parsedCorps.length} corps and saved ${savedRows} caption score rows. Fantasy standings have been updated.`
      );

      return res.redirect(
        `/admin/events/${req.params.eventId}/edit`
      );
    } catch (error) {
      if (
        error.status === 400
      ) {
        flash(
          req,
          'error',
          error.message
        );

        return res.redirect(
          `/admin/events/${req.params.eventId}/edit`
        );
      }

      next(error);
    }
  }
);


/*
 * =====================================================
 * DELETE EVENT
 * =====================================================
 */

router.post(
  '/admin/events/:eventId/delete',
  async (req, res, next) => {
    try {
      await query(`
        DELETE FROM events
        WHERE id = $1
      `, [
        req.params.eventId
      ]);

      flash(
        req,
        'success',
        'Event and its scores were deleted.'
      );

      return res.redirect(
        '/admin'
      );
    } catch (error) {
      next(error);
    }
  }
);


/*
 * =====================================================
 * DCI URL IMPORT
 * =====================================================
 */

router.post(
  '/admin/import-dci',
  async (req, res, next) => {
    try {
      const url =
        String(
          req.body.url
          || ''
        ).trim();

      const result =
        await importRecapUrl(
          url
        );

      flash(
        req,
        'success',
        `Imported ${result.name} with ${result.scoreCount} score rows.`
      );

      return res.redirect(
        `/admin/events/${result.eventId}/edit`
      );
    } catch (error) {
      await query(`
        INSERT INTO sync_runs (
          source,
          status,
          message
        )

        VALUES (
          'DCI',
          'ERROR',
          $1
        )
      `, [
        error.message
      ]).catch(
        () => {}
      );

      flash(
        req,
        'error',
        error.message
      );

      return res.redirect(
        '/admin'
      );
    }
  }
);


/*
 * =====================================================
 * AUTOMATIC DCI SYNC
 * =====================================================
 */

router.post(
  '/admin/sync-dci',
  async (req, res, next) => {
    try {
      const results =
        await syncDiscoveredRecaps();

      const succeeded =
        results.filter(
          (item) =>
            item.ok
        ).length;

      const failed =
        results.length
        - succeeded;

      flash(
        req,
        failed
          ? 'error'
          : 'success',

        `DCI sync finished: ${succeeded} imported or updated, ${failed} failed.`
      );

      return res.redirect(
        '/admin'
      );
    } catch (error) {
      await query(`
        INSERT INTO sync_runs (
          source,
          status,
          message
        )

        VALUES (
          'DCI',
          'ERROR',
          $1
        )
      `, [
        error.message
      ]).catch(
        () => {}
      );

      flash(
        req,
        'error',
        error.message
      );

      return res.redirect(
        '/admin'
      );
    }
  }
);


module.exports = router;
