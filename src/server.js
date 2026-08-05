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

async function main() {
  await migrate();

  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

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

  app.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.status(200).json({ ok: true });
    } catch (_error) {
      res.status(503).json({ ok: false });
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
    console.log(`CorpsDraft listening on port ${config.port}`);
  });

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
