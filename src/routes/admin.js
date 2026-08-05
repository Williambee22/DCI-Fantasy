const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAdmin, flash } = require('../middleware');
const { cleanText, slugify, asNumber, formatScore } = require('../utils');
const config = require('../config');
const { importRecapUrl, syncDiscoveredRecaps } = require('../services/dciImport');
const {
  parseRecapPaste
} = require('../services/recapPaste');

const router = express.Router();
router.use(requireAdmin);

router.get('/admin', async (req, res, next) => {
  try {
    const [events, corps, syncRuns, counts] = await Promise.all([
      query(`
        SELECT e.*, COUNT(s.id)::int AS score_rows
        FROM events e LEFT JOIN scores s ON s.event_id = e.id
        GROUP BY e.id ORDER BY e.event_date DESC, e.name
        LIMIT 100
      `),
      query('SELECT * FROM corps ORDER BY active DESC, name'),
      query('SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT 12'),
      query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM leagues) AS leagues,
          (SELECT COUNT(*)::int FROM draft_picks) AS picks,
          (SELECT COUNT(*)::int FROM scores) AS scores
      `)
    ]);

    res.render('admin/index', {
      title: 'Head Admin',
      events: events.rows,
      corps: corps.rows,
      syncRuns: syncRuns.rows,
      counts: counts.rows[0],
      dciImportEnabled: config.dciImportEnabled && config.dciPermissionConfirmed
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/corps', async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 120);
    if (name.length < 2) {
      flash(req, 'error', 'Corps name must be at least 2 characters.');
      return res.redirect('/admin');
    }
    await query(`
      INSERT INTO corps (name, slug, active)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, active = TRUE
    `, [name, slugify(name)]);
    flash(req, 'success', `${name} is available in drafts and score entry.`);
    res.redirect('/admin');
  } catch (error) {
    next(error);
  }
});

router.post('/admin/corps/:corpsId/toggle', async (req, res, next) => {
  try {
    await query('UPDATE corps SET active = NOT active WHERE id = $1', [req.params.corpsId]);
    flash(req, 'success', 'Corps availability updated.');
    res.redirect('/admin');
  } catch (error) {
    next(error);
  }
});

router.get('/admin/events/new', (req, res) => {
  res.render('admin/event-new', { title: 'Add Event', form: {} });
});

router.post('/admin/events', async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 160);
    const eventDate = String(req.body.event_date || '');
    const location = cleanText(req.body.location, 160) || null;
    if (name.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).render('admin/event-new', {
        title: 'Add Event',
        form: { name, event_date: eventDate, location },
        error: 'Enter an event name and valid date.'
      });
    }

    const baseSlug = slugify(`${eventDate}-${name}`);
    let slug = baseSlug;
    let event;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const result = await query(`
          INSERT INTO events (name, slug, event_date, location, source_kind, finalized)
          VALUES ($1, $2, $3, $4, 'MANUAL', TRUE)
          RETURNING *
        `, [name, slug, eventDate, location]);
        event = result.rows[0];
        break;
      } catch (error) {
        if (error.code !== '23505') throw error;
        slug = `${baseSlug}-${attempt + 2}`;
      }
    }
    if (!event) throw new Error('Could not create event with a unique slug.');
    res.redirect(`/admin/events/${event.id}/edit`);
  } catch (error) {
    next(error);
  }
});

router.get('/admin/events/:eventId/edit', async (req, res, next) => {
  try {
    const [eventResult, corpsResult, captionsResult, scoreResult] = await Promise.all([
      query('SELECT * FROM events WHERE id = $1', [req.params.eventId]),
      query('SELECT * FROM corps WHERE active = TRUE ORDER BY name'),
      query('SELECT * FROM captions ORDER BY sort_order'),
      query('SELECT * FROM scores WHERE event_id = $1', [req.params.eventId])
    ]);
    const event = eventResult.rows[0];
    if (!event) return res.status(404).render('error', { title: 'Event not found', message: 'That event does not exist.' });

    const scoreMap = {};
    for (const score of scoreResult.rows) {
      scoreMap[`${score.corps_id}:${score.caption_code}`] = score;
    }

    res.render('admin/event-edit', {
      title: `Scores: ${event.name}`,
      event,
      corps: corpsResult.rows,
      captions: captionsResult.rows,
      scoreMap,
      formatScore
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/events/:eventId/meta', async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 160);
    const eventDate = String(req.body.event_date || '');
    const location = cleanText(req.body.location, 160) || null;
    const finalized = req.body.finalized === 'on';
    if (name.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      flash(req, 'error', 'Event name and date are required.');
      return res.redirect(`/admin/events/${req.params.eventId}/edit`);
    }
    await query(`
      UPDATE events SET name = $1, event_date = $2, location = $3,
        finalized = $4, updated_at = NOW() WHERE id = $5
    `, [name, eventDate, location, finalized, req.params.eventId]);
    flash(req, 'success', 'Event details updated.');
    res.redirect(`/admin/events/${req.params.eventId}/edit`);
  } catch (error) {
    next(error);
  }
});

router.post('/admin/events/:eventId/scores', async (req, res, next) => {
  try {
    const eventResult = await query('SELECT id FROM events WHERE id = $1', [req.params.eventId]);
    if (!eventResult.rowCount) return res.status(404).render('error', { title: 'Event not found', message: 'That event does not exist.' });

    const submitted = req.body.scores || {};
    let saved = 0;
    await withTransaction(async (client) => {
      for (const [corpsId, captionValues] of Object.entries(submitted)) {
        for (const [captionCode, pair] of Object.entries(captionValues || {})) {
          const first = asNumber(pair.first);
          const second = asNumber(pair.second);
          if (first == null && second == null) {
            await client.query(`
              DELETE FROM scores WHERE event_id = $1 AND corps_id = $2 AND caption_code = $3
            `, [req.params.eventId, corpsId, captionCode]);
            continue;
          }
          if ((first != null && (first < 0 || first > 10)) || (second != null && (second < 0 || second > 10))) {
            throw Object.assign(new Error('Scores must be between 0.000 and 10.000.'), { status: 400 });
          }
          await client.query(`
            INSERT INTO scores (event_id, corps_id, caption_code, first_score, second_score)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (event_id, corps_id, caption_code) DO UPDATE SET
              first_score = EXCLUDED.first_score,
              second_score = EXCLUDED.second_score,
              updated_at = NOW()
          `, [req.params.eventId, corpsId, captionCode, first, second]);
          saved += 1;
        }
      }
    });
    flash(req, 'success', `Saved ${saved} caption score rows. Every fantasy league now reflects the update.`);
    res.redirect(`/admin/events/${req.params.eventId}/edit`);
  } catch (error) {
    if (error.status === 400) {
      flash(req, 'error', error.message);
      return res.redirect(`/admin/events/${req.params.eventId}/edit`);
    }
    next(error);
  }
});

router.post(
  '/admin/events/:eventId/paste-scores',
  async (req, res, next) => {
    try {
      const [
        eventResult,
        corpsResult
      ] = await Promise.all([
        query(`
          SELECT id, name
          FROM events
          WHERE id = $1
        `, [req.params.eventId]),

        query(`
          SELECT id, name
          FROM corps
          ORDER BY name
        `)
      ]);

      if (!eventResult.rowCount) {
        return res.status(404).render(
          'error',
          {
            title: 'Event not found',
            message: 'That event does not exist.'
          }
        );
      }

      const parsedCorps = parseRecapPaste(
        req.body.recap_text,
        corpsResult.rows
      );

      let savedRows = 0;

      await withTransaction(async (client) => {
        for (const parsedCorpsEntry of parsedCorps) {
          for (const score of parsedCorpsEntry.scores) {
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
                updated_at = NOW()
            `, [
              req.params.eventId,
              parsedCorpsEntry.corpsId,
              score.captionCode,
              score.firstScore,
              score.secondScore
            ]);

            savedRows += 1;
          }
        }
      });

      flash(
        req,
        'success',
        `Imported ${parsedCorps.length} corps and saved ${savedRows} caption score rows. Fantasy standings have been updated.`
      );

      return res.redirect(
        `/admin/events/${req.params.eventId}/edit`
      );
    } catch (error) {
      if (error.status === 400) {
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


router.post('/admin/events/:eventId/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM events WHERE id = $1', [req.params.eventId]);
    flash(req, 'success', 'Event and its scores were deleted.');
    res.redirect('/admin');
  } catch (error) {
    next(error);
  }
});

router.post('/admin/import-dci', async (req, res, next) => {
  try {
    const url = String(req.body.url || '').trim();
    const result = await importRecapUrl(url);
    flash(req, 'success', `Imported ${result.name} with ${result.scoreCount} score rows.`);
    res.redirect(`/admin/events/${result.eventId}/edit`);
  } catch (error) {
    await query(`INSERT INTO sync_runs (source, status, message) VALUES ('DCI', 'ERROR', $1)`, [error.message]).catch(() => {});
    flash(req, 'error', error.message);
    res.redirect('/admin');
  }
});

router.post('/admin/sync-dci', async (req, res, next) => {
  try {
    const results = await syncDiscoveredRecaps();
    const succeeded = results.filter((item) => item.ok).length;
    const failed = results.length - succeeded;
    flash(req, failed ? 'error' : 'success', `DCI sync finished: ${succeeded} imported or updated, ${failed} failed.`);
    res.redirect('/admin');
  } catch (error) {
    await query(`INSERT INTO sync_runs (source, status, message) VALUES ('DCI', 'ERROR', $1)`, [error.message]).catch(() => {});
    flash(req, 'error', error.message);
    res.redirect('/admin');
  }
});

module.exports = router;
