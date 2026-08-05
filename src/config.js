require('dotenv').config();

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || 'development-only-change-me',
  headAdminEmail: (process.env.HEAD_ADMIN_EMAIL || '').trim().toLowerCase(),
  adminBootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
  adminBootstrapUsername: process.env.ADMIN_BOOTSTRAP_USERNAME || 'headadmin',
  dciImportEnabled: bool('DCI_IMPORT_ENABLED'),
  dciPermissionConfirmed: bool('DCI_PERMISSION_CONFIRMED'),
  dciContactEmail: (process.env.DCI_CONTACT_EMAIL || '').trim(),
  dciSourceYear: Number(process.env.DCI_SOURCE_YEAR || new Date().getFullYear()),
  dciSyncCron: process.env.DCI_SYNC_CRON || '15 * * * *'
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required. Add a PostgreSQL service and expose DATABASE_URL.');
}

if (config.env === 'production' && config.sessionSecret === 'development-only-change-me') {
  throw new Error('SESSION_SECRET must be set in production.');
}

module.exports = config;
