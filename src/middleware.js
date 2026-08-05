const crypto = require('crypto');
const { query } = require('./db');

async function loadUser(req, res, next) {
  try {
    req.user = null;
    if (req.session.userId) {
      const result = await query(
        'SELECT id, email, username, site_role, created_at FROM users WHERE id = $1',
        [req.session.userId]
      );
      req.user = result.rows[0] || null;
      if (!req.user) delete req.session.userId;
    }
    res.locals.currentUser = req.user;
    next();
  } catch (error) {
    next(error);
  }
}

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const token = req.body?._csrf || req.get('x-csrf-token');
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).render('error', {
      title: 'Request expired',
      message: 'Your form expired. Refresh the page and try again.'
    });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.site_role !== 'ADMIN') {
    return res.status(403).render('error', {
      title: 'Head admin only',
      message: 'This page is restricted to the site head administrator.'
    });
  }
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function exposeFlash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}

async function requireLeagueMember(req, res, next) {
  try {
    const result = await query(`
      SELECT l.*, lm.team_name, lm.draft_position,
             (l.commissioner_id = $2) AS is_commissioner
      FROM leagues l
      JOIN league_members lm ON lm.league_id = l.id AND lm.user_id = $2
      WHERE l.id = $1
    `, [req.params.id, req.user.id]);

    if (!result.rowCount) {
      return res.status(404).render('error', {
        title: 'League not found',
        message: 'That league does not exist or you are not a member.'
      });
    }

    req.league = result.rows[0];
    res.locals.league = req.league;
    next();
  } catch (error) {
    next(error);
  }
}

function requireCommissioner(req, res, next) {
  if (!req.league?.is_commissioner) {
    return res.status(403).render('error', {
      title: 'Commissioner only',
      message: 'Only the league creator can manage this draft.'
    });
  }
  next();
}

module.exports = {
  loadUser,
  ensureCsrfToken,
  verifyCsrf,
  requireAuth,
  requireAdmin,
  exposeFlash,
  flash,
  requireLeagueMember,
  requireCommissioner
};
