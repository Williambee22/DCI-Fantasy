const { query } = require('../db');

async function getStandings(leagueId) {
  const result = await query(`
    SELECT
      lm.user_id,
      lm.team_name,
      u.username,
      COALESCE(SUM(
        CASE
          WHEN e.id IS NULL THEN 0
          WHEN dp.component = 'FIRST' THEN COALESCE(s.first_score, 0)
          WHEN dp.component = 'SECOND' THEN COALESCE(s.second_score, 0)
          ELSE 0
        END
      ), 0)::numeric AS total_points,
      COUNT(DISTINCT dp.id)::int AS drafted_assets
    FROM league_members lm
    JOIN leagues l ON l.id = lm.league_id
    JOIN users u ON u.id = lm.user_id
    LEFT JOIN draft_picks dp
      ON dp.league_id = lm.league_id AND dp.user_id = lm.user_id
    LEFT JOIN scores s
      ON s.corps_id = dp.corps_id AND s.caption_code = dp.caption_code
    LEFT JOIN events e
      ON e.id = s.event_id
      AND e.finalized = TRUE
      AND EXTRACT(YEAR FROM e.event_date)::int = l.season_year
    WHERE lm.league_id = $1
    GROUP BY lm.user_id, lm.team_name, u.username
    ORDER BY total_points DESC, lm.team_name ASC
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
      COALESCE(SUM(
        CASE
          WHEN e.id IS NULL THEN 0
          WHEN dp.component = 'FIRST' THEN COALESCE(s.first_score, 0)
          ELSE COALESCE(s.second_score, 0)
        END
      ), 0)::numeric AS points
    FROM draft_picks dp
    JOIN leagues l ON l.id = dp.league_id
    JOIN corps c ON c.id = dp.corps_id
    JOIN captions cap ON cap.code = dp.caption_code
    LEFT JOIN scores s ON s.corps_id = dp.corps_id AND s.caption_code = dp.caption_code
    LEFT JOIN events e ON e.id = s.event_id
      AND e.finalized = TRUE
      AND EXTRACT(YEAR FROM e.event_date)::int = l.season_year
    WHERE dp.league_id = $1
    GROUP BY dp.user_id, dp.id, dp.pick_number, dp.component, c.name,
             cap.code, cap.name, cap.first_label, cap.second_label
    ORDER BY dp.user_id, dp.pick_number
  `, [leagueId]);

  return result.rows.reduce((grouped, row) => {
    if (!grouped[row.user_id]) grouped[row.user_id] = [];
    grouped[row.user_id].push(row);
    return grouped;
  }, {});
}

module.exports = { getStandings, getRosterBreakdown };
