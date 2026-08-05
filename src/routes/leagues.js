const express = require('express');
const { query, withTransaction } = require('../db');
const {
  requireAuth,
  requireLeagueMember,
  requireCommissioner,
  flash
} = require('../middleware');
const { cleanText, inviteCode, shuffled, formatScore } = require('../utils');
const { snakeUserId, draftRound, totalDraftPicks } = require('../services/draft');
const { getStandings, getRosterBreakdown } = require('../services/standings');

const router = express.Router();
router.use(requireAuth);

router.get('/dashboard', async (req, res, next) => {
  try {
    const leagues = await query(`
      SELECT l.*, lm.team_name,
             (l.commissioner_id = $1) AS is_commissioner,
             (SELECT COUNT(*)::int FROM league_members x WHERE x.league_id = l.id) AS member_count
      FROM league_members lm
      JOIN leagues l ON l.id = lm.league_id
      WHERE lm.user_id = $1
      ORDER BY l.created_at DESC
    `, [req.user.id]);

    res.render('dashboard', { title: 'Dashboard', leagues: leagues.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/leagues', async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 100);
    const teamName = cleanText(req.body.team_name, 80) || `${req.user.username}'s Team`;
    const seasonYear = Number(req.body.season_year || new Date().getFullYear());
    if (name.length < 3) {
      flash(req, 'error', 'League name must be at least 3 characters.');
      return res.redirect('/dashboard');
    }
    if (!Number.isInteger(seasonYear) || seasonYear < 2000 || seasonYear > 2100) {
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
            INSERT INTO leagues (name, invite_code, commissioner_id, season_year)
            VALUES ($1, $2, $3, $4)
            RETURNING *
          `, [name, code, req.user.id, seasonYear]);
          await client.query(`
            INSERT INTO league_members (league_id, user_id, team_name, draft_position)
            VALUES ($1, $2, $3, 1)
          `, [created.rows[0].id, req.user.id, teamName]);
          return created.rows[0];
        });
        break;
      } catch (error) {
        if (error.code !== '23505') throw error;
      }
    }

    if (!league) throw new Error('Could not generate a unique invite code.');
    res.redirect(`/leagues/${league.id}`);
  } catch (error) {
    next(error);
  }
});

router.post('/leagues/join', async (req, res, next) => {
  try {
    const code = cleanText(req.body.invite_code, 16).toUpperCase();
    const teamName = cleanText(req.body.team_name, 80) || `${req.user.username}'s Team`;
    const leagueResult = await query('SELECT * FROM leagues WHERE invite_code = $1', [code]);
    const league = leagueResult.rows[0];
    if (!league) {
      flash(req, 'error', 'No league was found with that invite code.');
      return res.redirect('/dashboard');
    }
    if (league.draft_status !== 'SETUP') {
      flash(req, 'error', 'That league has already started its draft.');
      return res.redirect('/dashboard');
    }

    await query(`
      INSERT INTO league_members (league_id, user_id, team_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (league_id, user_id) DO UPDATE SET team_name = EXCLUDED.team_name
    `, [league.id, req.user.id, teamName]);
    res.redirect(`/leagues/${league.id}`);
  } catch (error) {
    next(error);
  }
});

router.get('/leagues/:id', requireLeagueMember, async (req, res, next) => {
  try {
    const members = await query(`
      SELECT lm.*, u.username
      FROM league_members lm
      JOIN users u ON u.id = lm.user_id
      WHERE lm.league_id = $1
      ORDER BY lm.draft_position NULLS LAST, lm.joined_at
    `, [req.league.id]);
    const standings = await getStandings(req.league.id);
    const rosters = await getRosterBreakdown(req.league.id);
    res.render('leagues/show', {
      title: req.league.name,
      members: members.rows,
      standings,
      rosters,
      formatScore
    });
  } catch (error) {
    next(error);
  }
});

router.post('/leagues/:id/settings', requireLeagueMember, requireCommissioner, async (req, res, next) => {
  try {
    if (req.league.draft_status !== 'SETUP') {
      flash(req, 'error', 'Roster size cannot change after the draft starts.');
      return res.redirect(`/leagues/${req.league.id}`);
    }
    const rosterSize = Number(req.body.roster_size);
    if (!Number.isInteger(rosterSize) || rosterSize < 1 || rosterSize > 32) {
      flash(req, 'error', 'Roster size must be between 1 and 32.');
      return res.redirect(`/leagues/${req.league.id}`);
    }
    await query('UPDATE leagues SET roster_size = $1, updated_at = NOW() WHERE id = $2', [rosterSize, req.league.id]);
    flash(req, 'success', 'League settings updated.');
    res.redirect(`/leagues/${req.league.id}`);
  } catch (error) {
    next(error);
  }
});

router.post('/leagues/:id/team-name', requireLeagueMember, async (req, res, next) => {
  try {
    const teamName = cleanText(req.body.team_name, 80);
    if (teamName.length < 2) {
      flash(req, 'error', 'Team name must be at least 2 characters.');
      return res.redirect(`/leagues/${req.league.id}`);
    }
    await query('UPDATE league_members SET team_name = $1 WHERE league_id = $2 AND user_id = $3', [teamName, req.league.id, req.user.id]);
    flash(req, 'success', 'Team name updated.');
    res.redirect(`/leagues/${req.league.id}`);
  } catch (error) {
    next(error);
  }
});

router.post('/leagues/:id/draft/order', requireLeagueMember, requireCommissioner, async (req, res, next) => {
  try {
    if (req.league.draft_status !== 'SETUP') {
      flash(req, 'error', 'Draft order cannot change after the draft starts.');
      return res.redirect(`/leagues/${req.league.id}`);
    }

    const membersResult = await query(`
      SELECT user_id FROM league_members WHERE league_id = $1 ORDER BY joined_at
    `, [req.league.id]);
    const positions = req.body.positions || {};
    const assignments = membersResult.rows.map((member) => ({
      userId: member.user_id,
      position: Number(positions[member.user_id])
    }));
    const expected = new Set(Array.from({ length: assignments.length }, (_, index) => index + 1));
    const actual = new Set(assignments.map((item) => item.position));
    const valid = assignments.every((item) => Number.isInteger(item.position))
      && actual.size === assignments.length
      && [...actual].every((position) => expected.has(position));

    if (!valid) {
      flash(req, 'error', `Use every draft position from 1 through ${assignments.length} exactly once.`);
      return res.redirect(`/leagues/${req.league.id}`);
    }

    await withTransaction(async (client) => {
      await client.query('UPDATE league_members SET draft_position = NULL WHERE league_id = $1', [req.league.id]);
      for (const assignment of assignments) {
        await client.query(`
          UPDATE league_members SET draft_position = $1 WHERE league_id = $2 AND user_id = $3
        `, [assignment.position, req.league.id, assignment.userId]);
      }
    });

    flash(req, 'success', 'Draft order saved.');
    res.redirect(`/leagues/${req.league.id}`);
  } catch (error) {
    next(error);
  }
});

router.post('/leagues/:id/draft/start', requireLeagueMember, requireCommissioner, async (req, res, next) => {
  try {
    if (req.league.draft_status !== 'SETUP') {
      flash(req, 'error', 'This draft has already been started.');
      return res.redirect(`/leagues/${req.league.id}/draft`);
    }

    await withTransaction(async (client) => {
      const memberResult = await client.query(`
        SELECT user_id, draft_position FROM league_members WHERE league_id = $1 ORDER BY joined_at FOR UPDATE
      `, [req.league.id]);
      const assetCountResult = await client.query(`
        SELECT COUNT(*)::int AS count FROM corps CROSS JOIN captions
        WHERE corps.active = TRUE
      `);
      const availableAssets = assetCountResult.rows[0].count * 2;
      const requestedPicks = memberResult.rows.length * req.league.roster_size;
      if (requestedPicks > availableAssets) {
        throw Object.assign(new Error(`Draft requires ${requestedPicks} assets, but only ${availableAssets} are available. Reduce roster size or add corps.`), { status: 400 });
      }
      const useSavedOrder = req.body.mode === 'saved';
      const hasCompleteSavedOrder = memberResult.rows.every((member) => Number.isInteger(member.draft_position))
        && new Set(memberResult.rows.map((member) => member.draft_position)).size === memberResult.rows.length;
      if (useSavedOrder && !hasCompleteSavedOrder) {
        throw Object.assign(new Error('Save a complete draft order before starting with the saved order.'), { status: 400 });
      }

      if (!useSavedOrder) {
        await client.query('UPDATE league_members SET draft_position = NULL WHERE league_id = $1', [req.league.id]);
        const ordered = shuffled(memberResult.rows);
        for (let i = 0; i < ordered.length; i += 1) {
          await client.query(`
            UPDATE league_members SET draft_position = $1 WHERE league_id = $2 AND user_id = $3
          `, [i + 1, req.league.id, ordered[i].user_id]);
        }
      }
      await client.query(`
        UPDATE leagues SET draft_status = 'ACTIVE', current_pick = 1, updated_at = NOW() WHERE id = $1
      `, [req.league.id]);
    });

    res.redirect(`/leagues/${req.league.id}/draft`);
  } catch (error) {
    if (error.status === 400) {
      flash(req, 'error', error.message);
      return res.redirect(`/leagues/${req.league.id}`);
    }
    next(error);
  }
});

router.post('/leagues/:id/draft/toggle', requireLeagueMember, requireCommissioner, async (req, res, next) => {
  try {
    if (!['ACTIVE', 'PAUSED'].includes(req.league.draft_status)) {
      flash(req, 'error', 'Only an active or paused draft can be changed.');
      return res.redirect(`/leagues/${req.league.id}/draft`);
    }
    const nextStatus = req.league.draft_status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    await query('UPDATE leagues SET draft_status = $1, updated_at = NOW() WHERE id = $2', [nextStatus, req.league.id]);
    flash(req, 'success', nextStatus === 'PAUSED' ? 'Draft paused.' : 'Draft resumed.');
    res.redirect(`/leagues/${req.league.id}/draft`);
  } catch (error) {
    next(error);
  }
});

router.post('/leagues/:id/draft/reset', requireLeagueMember, requireCommissioner, async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM draft_picks WHERE league_id = $1', [req.league.id]);
      await client.query('UPDATE league_members SET draft_position = NULL WHERE league_id = $1', [req.league.id]);
      await client.query(`
        UPDATE leagues SET draft_status = 'SETUP', current_pick = 1, updated_at = NOW() WHERE id = $1
      `, [req.league.id]);
    });
    flash(req, 'success', 'Draft reset. All picks were removed.');
    res.redirect(`/leagues/${req.league.id}`);
  } catch (error) {
    next(error);
  }
});

router.get('/leagues/:id/draft', requireLeagueMember, async (req, res, next) => {
  try {
    const captions = await query('SELECT * FROM captions ORDER BY sort_order');
    const corps = await query('SELECT * FROM corps WHERE active = TRUE ORDER BY name');
    res.render('leagues/draft', {
      title: `${req.league.name} Draft`,
      captions: captions.rows,
      corps: corps.rows
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/leagues/:id/draft-state', requireLeagueMember, async (req, res, next) => {
  try {
    const [leagueResult, membersResult, picksResult] = await Promise.all([
      query('SELECT * FROM leagues WHERE id = $1', [req.league.id]),
      query(`
        SELECT lm.user_id, lm.team_name, lm.draft_position, u.username
        FROM league_members lm JOIN users u ON u.id = lm.user_id
        WHERE lm.league_id = $1 ORDER BY lm.draft_position NULLS LAST, lm.joined_at
      `, [req.league.id]),
      query(`
        SELECT dp.*, c.name AS corps_name, cap.name AS caption_name,
               cap.first_label, cap.second_label, u.username, lm.team_name
        FROM draft_picks dp
        JOIN corps c ON c.id = dp.corps_id
        JOIN captions cap ON cap.code = dp.caption_code
        JOIN users u ON u.id = dp.user_id
        JOIN league_members lm ON lm.league_id = dp.league_id AND lm.user_id = dp.user_id
        WHERE dp.league_id = $1 ORDER BY dp.pick_number
      `, [req.league.id])
    ]);

    const league = leagueResult.rows[0];
    const members = membersResult.rows;
    const total = totalDraftPicks(members.length, league.roster_size);
    const onClockUserId = league.draft_status === 'ACTIVE' && league.current_pick <= total
      ? snakeUserId(members, league.current_pick)
      : null;

    res.json({
      league: {
        id: league.id,
        name: league.name,
        status: league.draft_status,
        currentPick: league.current_pick,
        round: draftRound(members.length, league.current_pick),
        rosterSize: league.roster_size,
        totalPicks: total
      },
      members,
      picks: picksResult.rows,
      onClockUserId,
      currentUserId: req.user.id,
      isCommissioner: req.league.is_commissioner
    });
  } catch (error) {
    next(error);
  }
});

router.post('/api/leagues/:id/picks', requireLeagueMember, async (req, res, next) => {
  try {
    const corpsId = String(req.body.corps_id || '');
    const captionCode = String(req.body.caption_code || '');
    const component = String(req.body.component || '');
    if (!['FIRST', 'SECOND'].includes(component)) {
      return res.status(400).json({ error: 'Choose Content/Achievement.' });
    }

    const result = await withTransaction(async (client) => {
      const leagueResult = await client.query('SELECT * FROM leagues WHERE id = $1 FOR UPDATE', [req.league.id]);
      const league = leagueResult.rows[0];
      if (league.draft_status !== 'ACTIVE') throw Object.assign(new Error('The draft is not active.'), { status: 409 });

      const membersResult = await client.query(`
        SELECT user_id, draft_position FROM league_members
        WHERE league_id = $1 ORDER BY draft_position
      `, [req.league.id]);
      const members = membersResult.rows;
      const total = totalDraftPicks(members.length, league.roster_size);
      if (league.current_pick > total) throw Object.assign(new Error('The draft is already complete.'), { status: 409 });

      const onClock = snakeUserId(members, league.current_pick);
      if (onClock !== req.user.id) throw Object.assign(new Error('It is not your turn.'), { status: 403 });

      const validAsset = await client.query(`
        SELECT c.id FROM corps c CROSS JOIN captions cap
        WHERE c.id = $1 AND c.active = TRUE AND cap.code = $2
      `, [corpsId, captionCode]);
      if (!validAsset.rowCount) throw Object.assign(new Error('That corps or caption is unavailable.'), { status: 400 });

      await client.query(`
        INSERT INTO draft_picks (league_id, user_id, corps_id, caption_code, component, pick_number)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [req.league.id, req.user.id, corpsId, captionCode, component, league.current_pick]);

      const nextPick = league.current_pick + 1;
      const nextStatus = nextPick > total ? 'COMPLETE' : 'ACTIVE';
      await client.query(`
        UPDATE leagues SET current_pick = $1, draft_status = $2, updated_at = NOW() WHERE id = $3
      `, [nextPick, nextStatus, req.league.id]);
      return { pickNumber: league.current_pick, status: nextStatus };
    });

    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'That corps/caption/component has already been drafted.' });
    }
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

module.exports = router;
