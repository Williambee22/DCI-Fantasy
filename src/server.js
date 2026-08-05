const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const helmet = require('helmet');
const cron = require('node-cron');
const config = require('./config');
const { pool, query } = require('./db');
const { migrate } = require('./migrate');
const {
  loadUser,
  ensureCsrfToken,
  verifyCsrf,
  exposeFlash
} = require('./middleware');
const authRoutes = require('./routes/auth');
const leagueRoutes = require('./routes/leagues');
const adminRoutes = require('./routes/admin');
const { syncDiscoveredRecaps } = require('./services/dciImport');

async function migrateWithRetry({ attempts = 30, delayMs = 2000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await migrate();
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `Database initialization attempt ${attempt}/${attempts} failed: ${error.message}`
      );

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function main() {
  const app = express();
  let databaseReady = false;
  let startupError = null;
  app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Railway calls this endpoint during deployment. Opening the HTTP listener
// before migrations lets Railway receive a real readiness response while
// PostgreSQL is still starting instead of a generic service-unavailable error.
app.get('/health', (_req, res) => {
  if (databaseReady) {
    return res.status(200).json({
      ok: true,
      database: 'ready'
    });
  }

  return res.status(503).json({
    ok: false,
    database: 'starting',
    error: startupError ? startupError.message : undefined
  });
});

// Do not serve application routes until migrations and seed data are ready.
app.use((req, res, next) => {
  if (databaseReady || req.path === '/health') {
    return next();
  }

  return res.status(503).send(
    'CorpsDraft is initializing its database.'
  );
});

app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'"],
        "script-src-attr": ["'none'"]
      }
    }
  }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.env === 'production' ? '1d' : 0 }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '200kb' }));

  const PgSession = pgSessionFactory(session);
  app.use(session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
    name: 'corpsdraft.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production',
      maxAge: 14 * 24 * 60 * 60 * 1000
    }
  }));

  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.appName = 'CorpsDraft';
    res.locals.currentUser = null;
    res.locals.csrfToken = '';
    res.locals.flash = null;
    next();
  });
  app.use(loadUser);
  app.use(ensureCsrfToken);
  app.use(exposeFlash);
  app.use(verifyCsrf);

  app.get('/', async (req, res, next) => {
    try {
      const counts = await query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM leagues) AS leagues,
          (SELECT COUNT(*)::int FROM draft_picks) AS picks
      `);
      res.render('home', { title: 'Fantasy Drum Corps', counts: counts.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.use(authRoutes);
  app.use(leagueRoutes);
  app.use(adminRoutes);

  app.use((_req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  app.use((error, req, res, _next) => {
    console.error(error);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'An unexpected server error occurred.' });
    }
    res.status(500).render('error', {
      title: 'Server error',
      message: config.env === 'production' ? 'An unexpected error occurred.' : error.message
    });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(
    `CorpsDraft HTTP server listening on 0.0.0.0:${config.port}`
  );
});

try {
  await migrateWithRetry();

  databaseReady = true;
  startupError = null;

  console.log('Database migrations and seed data are ready.');
} catch (error) {
  startupError = error;

  console.error(
    'Startup failed after database retries:',
    error
  );

  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(1);
  });

  return;
}

if (config.dciImportEnabled && config.dciPermissionConfirmed) {
    cron.schedule(config.dciSyncCron, async () => {
      try {
        const results = await syncDiscoveredRecaps();
        const successes = results.filter((item) => item.ok).length;
        console.log(`Scheduled DCI sync: ${successes}/${results.length} successful`);
      } catch (error) {
        console.error('Scheduled DCI sync failed:', error.message);
      }
    });
  }

  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});
