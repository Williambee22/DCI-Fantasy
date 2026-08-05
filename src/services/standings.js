const { query } = require('../db');

/**
 * Default DCI scoring:
 *
 * GE:
 *   GE1 + GE2
 *
 * Visual:
 *   (VP + VA + CG) / 2
 *
 * Music:
 *   (BRASS + MA + PERC) / 2
 *
 * Commissioner multipliers are applied to each drafted
 * subcaption before the section formula is applied.
 */
async function getStandings(leagueId) {
  const result = await query(`
    WITH scored_picks AS (
      SELECT
        lm.user_id,
        lm.team_name,
        u.username,
        dp.id AS pick_id,
        dp.caption_code,

        CASE
          WHEN e.id IS NULL THEN 0

          WHEN dp.component = 'FIRST'
            THEN COALESCE(s.first_score, 0)
              * COALESCE(lcw.first_weight, 1)

          WHEN dp.component = 'SECOND'
            THEN COALESCE(s.second_score, 0)
              * COALESCE(lcw.second_weight, 1)

          ELSE 0
        END::numeric AS weighted_score

      FROM league_members lm

      JOIN leagues l
        ON l.id = lm.league_id

      JOIN users u
        ON u.id = lm.user_id

      LEFT JOIN draft_picks dp
        ON dp.league_id = lm.league_id
        AND dp.user_id = lm.user_id

      LEFT JOIN league_caption_weights lcw
        ON lcw.league_id = lm.league_id
        AND lcw.caption_code = dp.caption_code

      LEFT JOIN scores s
        ON s.corps_id = dp.corps_id
        AND s.caption_code = dp.caption_code

      LEFT JOIN events e
        ON e.id = s.event_id
        AND e.finalized = TRUE
        AND EXTRACT(YEAR FROM e.event_date)::int =
          l.season_year

      WHERE lm.league_id = $1
    ),

    team_totals AS (
      SELECT
        user_id,
        team_name,
        username,

        COUNT(DISTINCT pick_id)::int
          AS drafted_assets,

        COALESCE(
          SUM(
            CASE
              WHEN caption_code IN ('GE1', 'GE2')
                THEN weighted_score
              ELSE 0
            END
          ),
          0
        )::numeric AS ge_points,

        (
          COALESCE(
            SUM(
              CASE
                WHEN caption_code IN ('VP', 'VA', 'CG')
                  THEN weighted_score
                ELSE 0
              END
            ),
            0
          ) / 2
        )::numeric AS visual_points,

        (
          COALESCE(
            SUM(
              CASE
                WHEN caption_code IN (
                  'BRASS',
                  'MA',
                  'PERC'
                )
                  THEN weighted_score
                ELSE 0
              END
            ),
            0
          ) / 2
        )::numeric AS music_points

      FROM scored_picks

      GROUP BY
        user_id,
        team_name,
        username
    )

    SELECT
      user_id,
      team_name,
      username,
      drafted_assets,
      ge_points,
      visual_points,
      music_points,

      (
        ge_points
        + visual_points
        + music_points
      )::numeric AS total_points

    FROM team_totals

    ORDER BY
      total_points DESC,
      team_name ASC
  `, [leagueId]);

  return result.rows;
}

async function getRosterBreakdown(leagueId) {
  const result = await query(`
    SELECT
      dp.user_id,
      dp.id AS pick_id,
      dp.pick_number,
      dp.component,

      c.name AS corps_name,

      cap.code AS caption_code,
      cap.name AS caption_name,
      cap.first_label,
      cap.second_label,
      cap.sort_order,

      CASE
        WHEN dp.caption_code IN ('GE1', 'GE2')
          THEN 'GENERAL_EFFECT'

        WHEN dp.caption_code IN ('VP', 'VA', 'CG')
          THEN 'VISUAL'

        WHEN dp.caption_code IN (
          'BRASS',
          'MA',
          'PERC'
        )
          THEN 'MUSIC'

        ELSE 'OTHER'
      END AS section_code,

      CASE
        WHEN dp.caption_code IN ('GE1', 'GE2')
          THEN 1.000
        ELSE 0.500
      END::numeric AS section_factor,

      CASE
        WHEN dp.component = 'FIRST'
          THEN COALESCE(lcw.first_weight, 1)

        ELSE COALESCE(lcw.second_weight, 1)
      END::numeric AS component_weight,

      COALESCE(
        SUM(
          CASE
            WHEN e.id IS NULL THEN 0

            WHEN dp.component = 'FIRST'
              THEN COALESCE(s.first_score, 0)

            ELSE COALESCE(s.second_score, 0)
          END
        ),
        0
      )::numeric AS raw_points,

      COALESCE(
        SUM(
          CASE
            WHEN e.id IS NULL THEN 0

            WHEN dp.component = 'FIRST'
              THEN COALESCE(s.first_score, 0)
                * COALESCE(lcw.first_weight, 1)

            ELSE COALESCE(s.second_score, 0)
              * COALESCE(lcw.second_weight, 1)
          END
        ),
        0
      )::numeric AS weighted_points,

      COALESCE(
        SUM(
          CASE
            WHEN e.id IS NULL THEN 0

            WHEN dp.component = 'FIRST'
              THEN COALESCE(s.first_score, 0)
                * COALESCE(lcw.first_weight, 1)
                * CASE
                    WHEN dp.caption_code IN (
                      'GE1',
                      'GE2'
                    )
                      THEN 1.000
                    ELSE 0.500
                  END

            ELSE COALESCE(s.second_score, 0)
              * COALESCE(lcw.second_weight, 1)
              * CASE
                  WHEN dp.caption_code IN (
                    'GE1',
                    'GE2'
                  )
                    THEN 1.000
                  ELSE 0.500
                END
          END
        ),
        0
      )::numeric AS points

    FROM draft_picks dp

    JOIN leagues l
      ON l.id = dp.league_id

    JOIN corps c
      ON c.id = dp.corps_id

    JOIN captions cap
      ON cap.code = dp.caption_code

    LEFT JOIN league_caption_weights lcw
      ON lcw.league_id = dp.league_id
      AND lcw.caption_code = dp.caption_code

    LEFT JOIN scores s
      ON s.corps_id = dp.corps_id
      AND s.caption_code = dp.caption_code

    LEFT JOIN events e
      ON e.id = s.event_id
      AND e.finalized = TRUE
      AND EXTRACT(YEAR FROM e.event_date)::int =
        l.season_year

    WHERE dp.league_id = $1

    GROUP BY
      dp.user_id,
      dp.id,
      dp.pick_number,
      dp.component,
      c.name,
      cap.code,
      cap.name,
      cap.first_label,
      cap.second_label,
      cap.sort_order,
      lcw.first_weight,
      lcw.second_weight

    ORDER BY
      dp.user_id,
      cap.sort_order,
      dp.component,
      dp.pick_number
  `, [leagueId]);

  return result.rows.reduce(
    (grouped, row) => {
      if (!grouped[row.user_id]) {
        grouped[row.user_id] = [];
      }

      grouped[row.user_id].push(row);

      return grouped;
    },
    {}
  );
}

module.exports = {
  getStandings,
  getRosterBreakdown
};
