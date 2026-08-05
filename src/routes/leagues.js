const express = require('express');
const { query, withTransaction } = require('../db');
const {
  requireAuth,
  requireLeagueMember,
  requireCommissioner,
  flash
} = require('../middleware');
const {
  cleanText,
  inviteCode,
  shuffled,
  formatScore,
  asNumber
} = require('../utils');
const {
  snakeUserId,
  draftRound,
  picksPerTeam,
  totalDraftPicks
} = require('../services/draft');
const {
  getStandings,
  getRosterBreakdown
} = require('../services/standings');

const router = express.Router();

router.use(requireAuth);

/**
 * User dashboard
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const leagues = await query(`
      SELECT
        l.*,
        lm.team_name,
        (l.commissioner_id = $1) AS is_commissioner,
        (
          SELECT COUNT(*)::int
          FROM league_members x
          WHERE x.league_id = l.id
        ) AS member_count
      FROM league_members lm
      JOIN leagues l
        ON l.id = lm.league_id
      WHERE lm.user_id = $1
      ORDER BY l.created_at DESC
    `, [req.user.id]);

    res.render('dashboard', {
      title: 'Dashboard',
      leagues: leagues.rows
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Create a league
 */
router.post('/leagues', async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 100);
    const teamName =
      cleanText(req.body.team_name, 80)
      || `${req.user.username}'s Team`;

    const seasonYear = Number(
      req.body.season_year || new Date().getFullYear()
    );

    if (name.length < 3) {
      flash(
        req,
        'error',
        'League name must be at least 3 characters.'
      );

      return res.redirect('/dashboard');
    }

    if (
      !Number.isInteger(seasonYear)
      || seasonYear < 2000
      || seasonYear > 2100
    ) {
      flash(req, 'error', 'Enter a valid season year.');
      return res.redirect('/dashboard');
    }

    let code;
    let league;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = inviteCode();

      try {
        league = await withTransaction(async (client) => {
          const created = await client.query(`
            INSERT INTO leagues (
              name,
              invite_code,
              commissioner_id,
              season_year,
              roster_size
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              (
                SELECT COUNT(*)::int * 2
                FROM captions
              )
            )
            RETURNING *
          `, [
            name,
            code,
            req.user.id,
            seasonYear
          ]);

          const createdLeague = created.rows[0];

          await client.query(`
            INSERT INTO league_members (
              league_id,
              user_id,
              team_name,
              draft_position
            )
            VALUES ($1, $2, $3, 1)
          `, [
            createdLeague.id,
            req.user.id,
            teamName
          ]);

          await client.query(`
            INSERT INTO league_caption_weights (
              league_id,
              caption_code,
              first_weight,
              second_weight
            )
            SELECT
              $1,
              code,
              1.000,
              1.000
            FROM captions
            ON CONFLICT (league_id, caption_code)
            DO NOTHING
          `, [createdLeague.id]);

          return createdLeague;
        });

        break;
      } catch (error) {
        if (error.code !== '23505') {
          throw error;
        }
      }
    }

    if (!league) {
      throw new Error(
        'Could not generate a unique invite code.'
      );
    }

    return res.redirect(`/leagues/${league.id}`);
  } catch (error) {
    next(error);
  }
});

/**
 * Join a league
 */
router.post('/leagues/join', async (req, res, next) => {
  try {
    const code = cleanText(
      req.body.invite_code,
      16
    ).toUpperCase();

    const teamName =
      cleanText(req.body.team_name, 80)
      || `${req.user.username}'s Team`;

    const leagueResult = await query(`
      SELECT *
      FROM leagues
      WHERE invite_code = $1
    `, [code]);

    const league = leagueResult.rows[0];

    if (!league) {
      flash(
        req,
        'error',
        'No league was found with that invite code.'
      );

      return res.redirect('/dashboard');
    }

    if (league.draft_status !== 'SETUP') {
      flash(
        req,
        'error',
        'That league has already started its draft.'
      );

      return res.redirect('/dashboard');
    }

    await query(`
      INSERT INTO league_members (
        league_id,
        user_id,
        team_name
      )
      VALUES ($1, $2, $3)

      ON CONFLICT (league_id, user_id)
      DO UPDATE SET
        team_name = EXCLUDED.team_name
    `, [
      league.id,
      req.user.id,
      teamName
    ]);

    return res.redirect(`/leagues/${league.id}`);
  } catch (error) {
    next(error);
  }
});

/**
 * League home page
 */
router.get(
  '/leagues/:id',
  requireLeagueMember,
  async (req, res, next) => {
    try {
      const members = await query(`
        SELECT
          lm.*,
          u.username
        FROM league_members lm
        JOIN users u
          ON u.id = lm.user_id
        WHERE lm.league_id = $1
        ORDER BY
          lm.draft_position NULLS LAST,
          lm.joined_at
      `, [req.league.id]);

      const [
        standings,
        rosters,
        captionWeightsResult
      ] = await Promise.all([
        getStandings(req.league.id),

        getRosterBreakdown(req.league.id),

        query(`
          SELECT
            cap.*,
            COALESCE(
              lcw.first_weight,
              1.000
            )::numeric AS first_weight,
            COALESCE(
              lcw.second_weight,
              1.000
            )::numeric AS second_weight
          FROM captions cap
          LEFT JOIN league_caption_weights lcw
            ON lcw.caption_code = cap.code
            AND lcw.league_id = $1
          ORDER BY cap.sort_order
        `, [req.league.id])
      ]);

      const requiredPicksPerTeam = picksPerTeam(
        captionWeightsResult.rows.length
      );

      res.render('leagues/show', {
        title: req.league.name,
        members: members.rows,
        standings,
        rosters,
        captionWeights: captionWeightsResult.rows,
        requiredPicksPerTeam,
        formatScore
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Commissioner scoring multipliers
 */
router.post(
  '/leagues/:id/scoring',
  requireLeagueMember,
  requireCommissioner,
  async (req, res, next) => {
    try {
      const captionsResult = await query(`
        SELECT code
        FROM captions
        ORDER BY sort_order
      `);

      const firstWeights =
        req.body.first_weights || {};

      const secondWeights =
        req.body.second_weights || {};

      const values = captionsResult.rows.map(
        ({ code }) => {
          const parsedFirstWeight = asNumber(
            firstWeights[code]
          );

          const parsedSecondWeight = asNumber(
            secondWeights[code]
          );

          return {
            code,

            firstWeight:
              parsedFirstWeight == null
                ? 1
                : parsedFirstWeight,

            secondWeight:
              parsedSecondWeight == null
                ? 1
                : parsedSecondWeight
          };
        }
      );

      const invalid = values.find(
        ({ firstWeight, secondWeight }) => (
          !Number.isFinite(firstWeight)
          || !Number.isFinite(secondWeight)
          || firstWeight < 0
          || firstWeight > 10
          || secondWeight < 0
          || secondWeight > 10
        )
      );

      if (invalid) {
        flash(
          req,
          'error',
          'Every scoring multiplier must be between 0.000 and 10.000.'
        );

        return res.redirect(
          `/leagues/${req.league.id}`
        );
      }

      await withTransaction(async (client) => {
        for (const value of values) {
          await client.query(`
            INSERT INTO league_caption_weights (
              league_id,
              caption_code,
              first_weight,
              second_weight,
              updated_at
            )
            VALUES ($1, $2, $3, $4, NOW())

            ON CONFLICT (
              league_id,
              caption_code
            )
            DO UPDATE SET
              first_weight =
                EXCLUDED.first_weight,
              second_weight =
                EXCLUDED.second_weight,
              updated_at = NOW()
          `, [
            req.league.id,
            value.code,
            value.firstWeight,
            value.secondWeight
          ]);
        }
      });

      flash(
        req,
        'success',
        'League scoring multipliers updated. Standings were recalculated immediately.'
      );

      return res.redirect(
        `/leagues/${req.league.id}`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Change team name
 */
router.post(
  '/leagues/:id/team-name',
  requireLeagueMember,
  async (req, res, next) => {
    try {
      const teamName = cleanText(
        req.body.team_name,
        80
      );

      if (teamName.length < 2) {
        flash(
          req,
          'error',
          'Team name must be at least 2 characters.'
        );

        return res.redirect(
          `/leagues/${req.league.id}`
        );
      }

      await query(`
        UPDATE league_members
        SET team_name = $1
        WHERE league_id = $2
          AND user_id = $3
      `, [
        teamName,
        req.league.id,
        req.user.id
      ]);

      flash(
        req,
        'success',
        'Team name updated.'
      );

      return res.redirect(
        `/leagues/${req.league.id}`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Save commissioner-selected draft order
 */
router.post(
  '/leagues/:id/draft/order',
  requireLeagueMember,
  requireCommissioner,
  async (req, res, next) => {
    try {
      if (req.league.draft_status !== 'SETUP') {
        flash(
          req,
          'error',
          'Draft order cannot change after the draft starts.'
        );

        return res.redirect(
          `/leagues/${req.league.id}`
        );
      }

      const membersResult = await query(`
        SELECT user_id
        FROM league_members
        WHERE league_id = $1
        ORDER BY joined_at
      `, [req.league.id]);

      const positions = req.body.positions || {};

      const assignments = membersResult.rows.map(
        (member) => ({
          userId: member.user_id,
          position: Number(
            positions[member.user_id]
          )
        })
      );

      const expected = new Set(
        Array.from(
          { length: assignments.length },
          (_, index) => index + 1
        )
      );

      const actual = new Set(
        assignments.map(
          (assignment) => assignment.position
        )
      );

      const valid =
        assignments.every(
          (assignment) =>
            Number.isInteger(assignment.position)
        )
        && actual.size === assignments.length
        && [...actual].every(
          (position) => expected.has(position)
        );

      if (!valid) {
        flash(
          req,
          'error',
          `Use every draft position from 1 through ${assignments.length} exactly once.`
        );

        return res.redirect(
          `/leagues/${req.league.id}`
        );
      }

      await withTransaction(async (client) => {
        await client.query(`
          UPDATE league_members
          SET draft_position = NULL
          WHERE league_id = $1
        `, [req.league.id]);

        for (const assignment of assignments) {
          await client.query(`
            UPDATE league_members
            SET draft_position = $1
            WHERE league_id = $2
              AND user_id = $3
          `, [
            assignment.position,
            req.league.id,
            assignment.userId
          ]);
        }
      });

      flash(
        req,
        'success',
        'Draft order saved.'
      );

      return res.redirect(
        `/leagues/${req.league.id}`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Start draft
 */
router.post(
  '/leagues/:id/draft/start',
  requireLeagueMember,
  requireCommissioner,
  async (req, res, next) => {
    try {
      if (req.league.draft_status !== 'SETUP') {
        flash(
          req,
          'error',
          'This draft has already been started.'
        );

        return res.redirect(
          `/leagues/${req.league.id}/draft`
        );
      }

      await withTransaction(async (client) => {
        const memberResult = await client.query(`
          SELECT
            user_id,
            draft_position
          FROM league_members
          WHERE league_id = $1
          ORDER BY joined_at
          FOR UPDATE
        `, [req.league.id]);

        const inventoryResult = await client.query(`
          SELECT
            (
              SELECT COUNT(*)::int
              FROM corps
              WHERE active = TRUE
            ) AS active_corps,

            (
              SELECT COUNT(*)::int
              FROM captions
            ) AS caption_count
        `);

        const activeCorps =
          inventoryResult.rows[0].active_corps;

        const captionCount =
          inventoryResult.rows[0].caption_count;

        const requiredPicksPerTeam =
          picksPerTeam(captionCount);

        if (captionCount < 1) {
          throw Object.assign(
            new Error(
              'At least one caption must exist before the draft can start.'
            ),
            { status: 400 }
          );
        }

        if (activeCorps < 1) {
          throw Object.assign(
            new Error(
              'At least one active corps must exist before the draft can start.'
            ),
            { status: 400 }
          );
        }

        /*
         * Every team must fill every caption/component
         * slot with a unique corps asset.
         *
         * For example, if there are four teams, Brass
         * Content needs at least four available corps.
         */
        if (memberResult.rows.length > activeCorps) {
          const neededCorps =
            memberResult.rows.length - activeCorps;

          throw Object.assign(
            new Error(
              `This league has ${memberResult.rows.length} teams, but only ${activeCorps} active corps. Add or reactivate at least ${neededCorps} corps before starting the draft.`
            ),
            { status: 400 }
          );
        }

        const useSavedOrder =
          req.body.mode === 'saved';

        const hasCompleteSavedOrder =
          memberResult.rows.every(
            (member) =>
              Number.isInteger(
                member.draft_position
              )
          )
          && new Set(
            memberResult.rows.map(
              (member) =>
                member.draft_position
            )
          ).size === memberResult.rows.length;

        if (
          useSavedOrder
          && !hasCompleteSavedOrder
        ) {
          throw Object.assign(
            new Error(
              'Save a complete draft order before starting with the saved order.'
            ),
            { status: 400 }
          );
        }

        if (!useSavedOrder) {
          await client.query(`
            UPDATE league_members
            SET draft_position = NULL
            WHERE league_id = $1
          `, [req.league.id]);

          const randomizedMembers = shuffled(
            memberResult.rows
          );

          for (
            let index = 0;
            index < randomizedMembers.length;
            index += 1
          ) {
            await client.query(`
              UPDATE league_members
              SET draft_position = $1
              WHERE league_id = $2
                AND user_id = $3
            `, [
              index + 1,
              req.league.id,
              randomizedMembers[index].user_id
            ]);
          }
        }

        await client.query(`
          UPDATE leagues
          SET
            draft_status = 'ACTIVE',
            current_pick = 1,
            roster_size = $2,
            updated_at = NOW()
          WHERE id = $1
        `, [
          req.league.id,
          requiredPicksPerTeam
        ]);

        await client.query(`
          INSERT INTO league_caption_weights (
            league_id,
            caption_code,
            first_weight,
            second_weight
          )
          SELECT
            $1,
            code,
            1.000,
            1.000
          FROM captions

          ON CONFLICT (
            league_id,
            caption_code
          )
          DO NOTHING
        `, [req.league.id]);
      });

      return res.redirect(
        `/leagues/${req.league.id}/draft`
      );
    } catch (error) {
      if (error.status === 400) {
        flash(
          req,
          'error',
          error.message
        );

        return res.redirect(
          `/leagues/${req.league.id}`
        );
      }

      next(error);
    }
  }
);

/**
 * Pause or resume draft
 */
router.post(
  '/leagues/:id/draft/toggle',
  requireLeagueMember,
  requireCommissioner,
  async (req, res, next) => {
    try {
      if (
        !['ACTIVE', 'PAUSED'].includes(
          req.league.draft_status
        )
      ) {
        flash(
          req,
          'error',
          'Only an active or paused draft can be changed.'
        );

        return res.redirect(
          `/leagues/${req.league.id}/draft`
        );
      }

      const nextStatus =
        req.league.draft_status === 'ACTIVE'
          ? 'PAUSED'
          : 'ACTIVE';

      await query(`
        UPDATE leagues
        SET
          draft_status = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [
        nextStatus,
        req.league.id
      ]);

      flash(
        req,
        'success',
        nextStatus === 'PAUSED'
          ? 'Draft paused.'
          : 'Draft resumed.'
      );

      return res.redirect(
        `/leagues/${req.league.id}/draft`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Reset draft
 */
router.post(
  '/leagues/:id/draft/reset',
  requireLeagueMember,
  requireCommissioner,
  async (req, res, next) => {
    try {
      await withTransaction(async (client) => {
        await client.query(`
          DELETE FROM draft_picks
          WHERE league_id = $1
        `, [req.league.id]);

        await client.query(`
          UPDATE league_members
          SET draft_position = NULL
          WHERE league_id = $1
        `, [req.league.id]);

        await client.query(`
          UPDATE leagues
          SET
            draft_status = 'SETUP',
            current_pick = 1,
            updated_at = NOW()
          WHERE id = $1
        `, [req.league.id]);
      });

      flash(
        req,
        'success',
        'Draft reset. All picks were removed.'
      );

      return res.redirect(
        `/leagues/${req.league.id}`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Draft room
 */
router.get(
  '/leagues/:id/draft',
  requireLeagueMember,
  async (req, res, next) => {
    try {
      const [
        captions,
        corps
      ] = await Promise.all([
        query(`
          SELECT *
          FROM captions
          ORDER BY sort_order
        `),

        query(`
          SELECT *
          FROM corps
          WHERE active = TRUE
          ORDER BY name
        `)
      ]);

      res.render('leagues/draft', {
        title: `${req.league.name} Draft`,
        captions: captions.rows,
        corps: corps.rows,
        requiredPicksPerTeam: picksPerTeam(
          captions.rows.length
        )
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Current draft state
 */
router.get(
  '/api/leagues/:id/draft-state',
  requireLeagueMember,
  async (req, res, next) => {
    try {
      const [
        leagueResult,
        membersResult,
        picksResult,
        captionCountResult
      ] = await Promise.all([
        query(`
          SELECT *
          FROM leagues
          WHERE id = $1
        `, [req.league.id]),

        query(`
          SELECT
            lm.user_id,
            lm.team_name,
            lm.draft_position,
            u.username
          FROM league_members lm
          JOIN users u
            ON u.id = lm.user_id
          WHERE lm.league_id = $1
          ORDER BY
            lm.draft_position NULLS LAST,
            lm.joined_at
        `, [req.league.id]),

        query(`
          SELECT
            dp.*,
            c.name AS corps_name,
            cap.name AS caption_name,
            cap.first_label,
            cap.second_label,
            u.username,
            lm.team_name
          FROM draft_picks dp
          JOIN corps c
            ON c.id = dp.corps_id
          JOIN captions cap
            ON cap.code = dp.caption_code
          JOIN users u
            ON u.id = dp.user_id
          JOIN league_members lm
            ON lm.league_id = dp.league_id
            AND lm.user_id = dp.user_id
          WHERE dp.league_id = $1
          ORDER BY dp.pick_number
        `, [req.league.id]),

        query(`
          SELECT COUNT(*)::int AS count
          FROM captions
        `)
      ]);

      const league = leagueResult.rows[0];
      const members = membersResult.rows;
      const captionCount =
        captionCountResult.rows[0].count;

      const requiredPicksPerTeam =
        picksPerTeam(captionCount);

      const total = totalDraftPicks(
        members.length,
        captionCount
      );

      const onClockUserId =
        league.draft_status === 'ACTIVE'
        && league.current_pick <= total
          ? snakeUserId(
              members,
              league.current_pick
            )
          : null;

      const displayedPickNumber =
        total > 0
          ? Math.min(
              league.current_pick,
              total
            )
          : 0;

      res.json({
        league: {
          id: league.id,
          name: league.name,
          status: league.draft_status,
          currentPick: league.current_pick,
          round: draftRound(
            members.length,
            displayedPickNumber
          ),
          rosterSize: requiredPicksPerTeam,
          totalPicks: total
        },
        members,
        picks: picksResult.rows,
        onClockUserId,
        currentUserId: req.user.id,
        isCommissioner:
          req.league.is_commissioner
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Submit draft pick
 */
router.post(
  '/api/leagues/:id/picks',
  requireLeagueMember,
  async (req, res, next) => {
    try {
      const corpsId = String(
        req.body.corps_id || ''
      );

      const captionCode = String(
        req.body.caption_code || ''
      );

      const component = String(
        req.body.component || ''
      );

      if (
        !['FIRST', 'SECOND'].includes(
          component
        )
      ) {
        return res.status(400).json({
          error: 'Choose Content or Achievement.'
        });
      }

      const result = await withTransaction(
        async (client) => {
          const leagueResult =
            await client.query(`
              SELECT *
              FROM leagues
              WHERE id = $1
              FOR UPDATE
            `, [req.league.id]);

          const league = leagueResult.rows[0];

          if (
            league.draft_status !== 'ACTIVE'
          ) {
            throw Object.assign(
              new Error(
                'The draft is not active.'
              ),
              { status: 409 }
            );
          }

          const [
            membersResult,
            captionCountResult
          ] = await Promise.all([
            client.query(`
              SELECT
                user_id,
                draft_position
              FROM league_members
              WHERE league_id = $1
              ORDER BY draft_position
            `, [req.league.id]),

            client.query(`
              SELECT COUNT(*)::int AS count
              FROM captions
            `)
          ]);

          const members = membersResult.rows;

          const captionCount =
            captionCountResult.rows[0].count;

          const total = totalDraftPicks(
            members.length,
            captionCount
          );

          if (league.current_pick > total) {
            throw Object.assign(
              new Error(
                'The draft is already complete.'
              ),
              { status: 409 }
            );
          }

          const onClock = snakeUserId(
            members,
            league.current_pick
          );

          if (onClock !== req.user.id) {
            throw Object.assign(
              new Error(
                'It is not your turn.'
              ),
              { status: 403 }
            );
          }

          const validAsset =
            await client.query(`
              SELECT
                c.id,
                cap.code
              FROM corps c
              CROSS JOIN captions cap
              WHERE c.id = $1
                AND c.active = TRUE
                AND cap.code = $2
            `, [
              corpsId,
              captionCode
            ]);

          if (!validAsset.rowCount) {
            throw Object.assign(
              new Error(
                'That corps or caption is unavailable.'
              ),
              { status: 400 }
            );
          }

          /*
           * A manager may only own one asset for each
           * caption/component slot.
           *
           * Example:
           * Bluecoats Brass Content fills Brass Content,
           * so that manager cannot also take Crown Brass
           * Content.
           */
          const existingTeamSlot =
            await client.query(`
              SELECT 1
              FROM draft_picks
              WHERE league_id = $1
                AND user_id = $2
                AND caption_code = $3
                AND component = $4
            `, [
              req.league.id,
              req.user.id,
              captionCode,
              component
            ]);

          if (existingTeamSlot.rowCount) {
            const componentName =
              component === 'FIRST'
                ? 'Content'
                : 'Achievement';

            throw Object.assign(
              new Error(
                `Your team already drafted ${componentName} for this caption. Every team gets exactly one Content and one Achievement selection from every caption.`
              ),
              { status: 409 }
            );
          }

          /*
           * The exact corps/caption/component asset can
           * only be drafted once in the entire league.
           */
          const existingLeagueAsset =
            await client.query(`
              SELECT 1
              FROM draft_picks
              WHERE league_id = $1
                AND corps_id = $2
                AND caption_code = $3
                AND component = $4
            `, [
              req.league.id,
              corpsId,
              captionCode,
              component
            ]);

          if (existingLeagueAsset.rowCount) {
            throw Object.assign(
              new Error(
                'That exact corps, caption, and subcaption combination has already been drafted by another team.'
              ),
              { status: 409 }
            );
          }

          await client.query(`
            INSERT INTO draft_picks (
              league_id,
              user_id,
              corps_id,
              caption_code,
              component,
              pick_number
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6
            )
          `, [
            req.league.id,
            req.user.id,
            corpsId,
            captionCode,
            component,
            league.current_pick
          ]);

          /*
           * The draft is only complete when every manager
           * has both components from every caption.
           */
          const missingSlotsResult =
            await client.query(`
              SELECT COUNT(*)::int AS missing
              FROM league_members lm
              CROSS JOIN captions cap
              CROSS JOIN (
                VALUES ('FIRST'), ('SECOND')
              ) AS components(component)
              WHERE lm.league_id = $1
                AND NOT EXISTS (
                  SELECT 1
                  FROM draft_picks dp
                  WHERE dp.league_id =
                    lm.league_id
                    AND dp.user_id =
                      lm.user_id
                    AND dp.caption_code =
                      cap.code
                    AND dp.component =
                      components.component
                )
            `, [req.league.id]);

          const missingSlots =
            missingSlotsResult.rows[0].missing;

          const nextPick =
            league.current_pick + 1;

          const nextStatus =
            missingSlots === 0
              ? 'COMPLETE'
              : 'ACTIVE';

          await client.query(`
            UPDATE leagues
            SET
              current_pick = $1,
              draft_status = $2,
              updated_at = NOW()
            WHERE id = $3
          `, [
            nextPick,
            nextStatus,
            req.league.id
          ]);

          return {
            pickNumber: league.current_pick,
            status: nextStatus,
            missingSlots
          };
        }
      );

      return res.status(201).json({
        ok: true,
        ...result
      });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error:
            'That exact asset has already been drafted, or your team already filled that caption slot.'
        });
      }

      if (error.status) {
        return res.status(error.status).json({
          error: error.message
        });
      }

      next(error);
    }
  }
);

module.exports = router;
