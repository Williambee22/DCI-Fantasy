const { Pool } = require('pg');
const config = require('./config');

const ssl = process.env.PGSSLMODE === 'require'
  ? { rejectUnauthorized: false }
  : undefined;

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
