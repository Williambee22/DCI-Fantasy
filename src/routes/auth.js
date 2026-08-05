const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const config = require('../config');
const { normalizeEmail, cleanText } = require('../utils');
const { flash } = require('../middleware');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many authentication attempts. Try again later.'
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/register', { title: 'Create account', form: {} });
});

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const username = cleanText(req.body.username, 40);
    const password = String(req.body.password || '');
    const form = { email, username };

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).render('auth/register', { title: 'Create account', form, error: 'Enter a valid email address.' });
    }
    if (!/^[A-Za-z0-9_]{3,40}$/.test(username)) {
      return res.status(400).render('auth/register', { title: 'Create account', form, error: 'Username must be 3–40 characters using letters, numbers, or underscores.' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).render('auth/register', { title: 'Create account', form, error: 'Password must be at least 8 characters.' });
    }

    const duplicate = await query('SELECT email, username FROM users WHERE email = $1 OR username = $2', [email, username]);
    if (duplicate.rowCount) {
      return res.status(409).render('auth/register', { title: 'Create account', form, error: 'That email or username is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const role = config.headAdminEmail && email === config.headAdminEmail ? 'ADMIN' : 'USER';
    const result = await query(`
      INSERT INTO users (email, username, password_hash, site_role)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [email, username, passwordHash, role]);

    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = result.rows[0].id;
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.redirect('/dashboard');
      });
    });
  } catch (error) {
    next(error);
  }
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Log in', form: {} });
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const result = await query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!valid) {
      return res.status(401).render('auth/login', {
        title: 'Log in',
        form: { email },
        error: 'Incorrect email or password.'
      });
    }

    const returnTo = req.session.returnTo || '/dashboard';
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.redirect(returnTo);
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('corpsdraft.sid');
    res.redirect('/');
  });
});

module.exports = router;
