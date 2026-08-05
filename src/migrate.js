const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('./db');
const config = require('./config');
const {
  slugify,
  normalizeEmail
} = require('./utils');

const captions = [
  ['GE1', 'General Effect 1', 'Repertoire', 'Performance', 10],
  ['GE2', 'General Effect 2', 'Repertoire', 'Performance', 20],
  ['VP', 'Visual Proficiency', 'Content', 'Achievement', 30],
  ['VA', 'Visual Analysis', 'Composition', 'Achievement', 40],
  ['CG', 'Color Guard', 'Content', 'Achievement', 50],
  ['BRASS', 'Brass', 'Content', 'Achievement', 60],
  ['MA', 'Music Analysis', 'Content', 'Achievement', 70],
  ['PERC', 'Percussion', 'Content', 'Achievement', 80]
];

const corps = [
  'The Academy',
  'Blue Devils',
  'Blue Knights',
  'Blue Stars',
  'Bluecoats',
  'Boston Crusaders',
  'Carolina Crown',
  'The Cavaliers',
  'Colts',
  'Crossmen',
  'Genesis',
  'Madison Scouts',
  'Mandarins',
  'Music City',
  'Pacific Crest',
  'Phantom Regiment',
  'Santa Clara Vanguard',
  'Seattle Cascades',
  'Spirit of Atlanta',
  'Spartans',
  'Troopers'
];

async function migrate() {
  await query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto
  `);

  /*
   * Create all base tables.
   */
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      email VARCHAR(255) NOT NULL UNIQUE,

      username VARCHAR(40) NOT NULL UNIQUE,

      password_hash TEXT NOT NULL,

      site_role VARCHAR(20) NOT NULL DEFAULT 'USER'
        CHECK (site_role IN ('USER', 'ADMIN')),

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS corps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      name VARCHAR(120) NOT NULL UNIQUE,

      slug VARCHAR(120) NOT NULL UNIQUE,

      active BOOLEAN NOT NULL DEFAULT TRUE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS captions (
      code VARCHAR(20) PRIMARY KEY,

      name VARCHAR(80) NOT NULL,

      first_label VARCHAR(40) NOT NULL,

      second_label VARCHAR(40) NOT NULL,

      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leagues (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      name VARCHAR(100) NOT NULL,

      invite_code VARCHAR(16) NOT NULL UNIQUE,

      commissioner_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

      season_year INTEGER NOT NULL
        DEFAULT (
          EXTRACT(YEAR FROM CURRENT_DATE)::int
        ),

      roster_size INTEGER NOT NULL DEFAULT 16
        CHECK (roster_size BETWEEN 1 AND 32),

      draft_status VARCHAR(20) NOT NULL DEFAULT 'SETUP'
        CHECK (
          draft_status IN (
            'SETUP',
            'ACTIVE',
            'PAUSED',
            'COMPLETE'
          )
        ),

      current_pick INTEGER NOT NULL DEFAULT 1,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS league_members (
      league_id UUID NOT NULL
        REFERENCES leagues(id)
        ON DELETE CASCADE,

      user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      team_name VARCHAR(80) NOT NULL,

      draft_position INTEGER,

      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        league_id,
        user_id
      ),

      UNIQUE (
        league_id,
        draft_position
      )
    );

    /*
     * Stores commissioner scoring multipliers for
     * every caption and subcaption.
     */
    CREATE TABLE IF NOT EXISTS league_caption_weights (
      league_id UUID NOT NULL
        REFERENCES leagues(id)
        ON DELETE CASCADE,

      caption_code VARCHAR(20) NOT NULL
        REFERENCES captions(code)
        ON DELETE CASCADE,

      first_weight NUMERIC(6,3) NOT NULL DEFAULT 1.000
        CHECK (
          first_weight BETWEEN 0 AND 10
        ),

      second_weight NUMERIC(6,3) NOT NULL DEFAULT 1.000
        CHECK (
          second_weight BETWEEN 0 AND 10
        ),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        league_id,
        caption_code
      )
    );

    CREATE TABLE IF NOT EXISTS draft_picks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      league_id UUID NOT NULL
        REFERENCES leagues(id)
        ON DELETE CASCADE,

      user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      corps_id UUID NOT NULL
        REFERENCES corps(id)
        ON DELETE RESTRICT,

      caption_code VARCHAR(20) NOT NULL
        REFERENCES captions(code)
        ON DELETE RESTRICT,

      component VARCHAR(20) NOT NULL
        CHECK (
          component IN (
            'FIRST',
            'SECOND'
          )
        ),

      pick_number INTEGER NOT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      /*
       * Prevents the exact corps, caption, and
       * subcaption asset from being drafted twice
       * in one league.
       */
      UNIQUE (
        league_id,
        corps_id,
        caption_code,
        component
      ),

      UNIQUE (
        league_id,
        pick_number
      )
    );

    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      name VARCHAR(160) NOT NULL,

      slug VARCHAR(180) NOT NULL UNIQUE,

      event_date DATE NOT NULL,

      location VARCHAR(160),

      source_url TEXT,

      source_kind VARCHAR(30) NOT NULL DEFAULT 'MANUAL',

      finalized BOOLEAN NOT NULL DEFAULT TRUE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scores (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      event_id UUID NOT NULL
        REFERENCES events(id)
        ON DELETE CASCADE,

      corps_id UUID NOT NULL
        REFERENCES corps(id)
        ON DELETE CASCADE,

      caption_code VARCHAR(20) NOT NULL
        REFERENCES captions(code)
        ON DELETE RESTRICT,

      first_score NUMERIC(6,3),

      second_score NUMERIC(6,3),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (
        event_id,
        corps_id,
        caption_code
      )
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      source VARCHAR(40) NOT NULL,

      status VARCHAR(20) NOT NULL,

      message TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_members_user
      ON league_members(user_id);

    CREATE INDEX IF NOT EXISTS idx_picks_league_user
      ON draft_picks(
        league_id,
        user_id
      );

    CREATE INDEX IF NOT EXISTS idx_weights_league
      ON league_caption_weights(league_id);

    CREATE INDEX IF NOT EXISTS idx_scores_corps_caption
      ON scores(
        corps_id,
        caption_code
      );

    CREATE INDEX IF NOT EXISTS idx_events_date
      ON events(event_date DESC);
  `);

  /*
   * Update databases created by older versions.
   */
  await query(`
    ALTER TABLE leagues
      ADD COLUMN IF NOT EXISTS season_year INTEGER;

    UPDATE leagues
    SET season_year =
      EXTRACT(YEAR FROM created_at)::int
    WHERE season_year IS NULL;

    ALTER TABLE leagues
      ALTER COLUMN season_year SET NOT NULL;

    ALTER TABLE leagues
      ALTER COLUMN season_year
      SET DEFAULT (
        EXTRACT(YEAR FROM CURRENT_DATE)::int
      );

    ALTER TABLE leagues
      ALTER COLUMN roster_size
      SET DEFAULT 16;
  `);

  /*
   * Insert or update all captions and corps before
   * creating default league scoring rows.
   */
  await withTransaction(async (client) => {
    for (
      const [
        code,
        name,
        firstLabel,
        secondLabel,
        sortOrder
      ] of captions
    ) {
      await client.query(`
        INSERT INTO captions (
          code,
          name,
          first_label,
          second_label,
          sort_order
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5
        )

        ON CONFLICT (code)
        DO UPDATE SET
          name = EXCLUDED.name,
          first_label = EXCLUDED.first_label,
          second_label = EXCLUDED.second_label,
          sort_order = EXCLUDED.sort_order
      `, [
        code,
        name,
        firstLabel,
        secondLabel,
        sortOrder
      ]);
    }

    for (const name of corps) {
      await client.query(`
        INSERT INTO corps (
          name,
          slug
        )
        VALUES (
          $1,
          $2
        )

        ON CONFLICT (name)
        DO NOTHING
      `, [
        name,
        slugify(name)
      ]);
    }
  });

  /*
   * Upgrade existing leagues and draft picks.
   */
  await query(`
    /*
     * If an existing manager has multiple picks for
     * the same caption/component slot, keep only the
     * earliest pick.
     */
    DELETE FROM draft_picks dp
    USING (
      SELECT id
      FROM (
        SELECT
          id,

          ROW_NUMBER() OVER (
            PARTITION BY
              league_id,
              user_id,
              caption_code,
              component

            ORDER BY
              pick_number,
              created_at,
              id
          ) AS duplicate_number

        FROM draft_picks
      ) ranked_duplicates

      WHERE duplicate_number > 1
    ) duplicates

    WHERE dp.id = duplicates.id;

    /*
     * Temporarily make pick numbers negative so they
     * can be safely renumbered without violating the
     * existing league/pick-number unique constraint.
     */
    UPDATE draft_picks
    SET pick_number = -ABS(pick_number);

    WITH ranked_picks AS (
      SELECT
        id,

        ROW_NUMBER() OVER (
          PARTITION BY league_id
          ORDER BY
            ABS(pick_number),
            created_at,
            id
        ) AS new_pick_number

      FROM draft_picks
    )

    UPDATE draft_picks dp
    SET pick_number =
      ranked_picks.new_pick_number

    FROM ranked_picks

    WHERE dp.id = ranked_picks.id;

    /*
     * Prevent one manager from drafting two assets
     * for the same caption/subcaption roster slot.
     *
     * Example:
     * A manager cannot own both Bluecoats Brass
     * Content and Crown Brass Content.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS
      uq_draft_picks_user_caption_component

    ON draft_picks (
      league_id,
      user_id,
      caption_code,
      component
    );

    /*
     * Every league now requires two picks for every
     * caption: one first component and one second
     * component.
     */
    UPDATE leagues
    SET
      roster_size = (
        SELECT COUNT(*)::int * 2
        FROM captions
      ),

      current_pick = COALESCE(
        (
          SELECT MAX(dp.pick_number) + 1
          FROM draft_picks dp
          WHERE dp.league_id = leagues.id
        ),
        1
      ),

      updated_at = NOW();

    /*
     * Recalculate whether existing drafts are setup,
     * active, paused, or complete.
     */
    UPDATE leagues l
    SET
      draft_status = CASE
        /*
         * A league with no picks that was still in
         * setup remains in setup.
         */
        WHEN l.draft_status = 'SETUP'
          AND NOT EXISTS (
            SELECT 1
            FROM draft_picks dp
            WHERE dp.league_id = l.id
          )
        THEN 'SETUP'

        /*
         * Preserve manually paused drafts.
         */
        WHEN l.draft_status = 'PAUSED'
        THEN 'PAUSED'

        /*
         * Complete only when at least one manager
         * exists and every manager has both slots
         * from every caption.
         */
        WHEN EXISTS (
          SELECT 1
          FROM league_members lm
          WHERE lm.league_id = l.id
        )
        AND NOT EXISTS (
          SELECT 1

          FROM league_members lm

          CROSS JOIN captions cap

          CROSS JOIN (
            VALUES
              ('FIRST'),
              ('SECOND')
          ) AS components(component)

          WHERE lm.league_id = l.id

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
        )
        THEN 'COMPLETE'

        ELSE 'ACTIVE'
      END,

      updated_at = NOW();
  `);

  /*
   * Add normal 1.000 scoring multipliers for every
   * existing league and caption.
   */
  await query(`
    INSERT INTO league_caption_weights (
      league_id,
      caption_code,
      first_weight,
      second_weight
    )

    SELECT
      l.id,
      cap.code,
      1.000,
      1.000

    FROM leagues l

    CROSS JOIN captions cap

    ON CONFLICT (
      league_id,
      caption_code
    )
    DO NOTHING;
  `);

  await bootstrapAdmin();
}

async function bootstrapAdmin() {
  const email = normalizeEmail(
    config.headAdminEmail
  );

  if (!email) {
    return;
  }

  const existing = await query(`
    SELECT id
    FROM users
    WHERE email = $1
  `, [email]);

  if (existing.rowCount) {
    await query(`
      UPDATE users
      SET site_role = $1
      WHERE email = $2
    `, [
      'ADMIN',
      email
    ]);

    return;
  }

  if (!config.adminBootstrapPassword) {
    return;
  }

  const passwordHash = await bcrypt.hash(
    config.adminBootstrapPassword,
    12
  );

  let username = String(
    config.adminBootstrapUsername || 'headadmin'
  )
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 40)
    || 'headadmin';

  const usernameTaken = await query(`
    SELECT 1
    FROM users
    WHERE username = $1
  `, [username]);

  if (usernameTaken.rowCount) {
    username =
      `${username}${Date.now().toString().slice(-4)}`
        .slice(0, 40);
  }

  await query(`
    INSERT INTO users (
      email,
      username,
      password_hash,
      site_role
    )
    VALUES (
      $1,
      $2,
      $3,
      'ADMIN'
    )
  `, [
    email,
    username,
    passwordHash
  ]);
}

module.exports = {
  migrate
};
