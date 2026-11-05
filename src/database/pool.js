const { Pool, types } = require('pg');
const config = require('../config/env');
const camelize = require('../utils/camel');

// DATE -> 'YYYY-MM-DD' string (avoid timezone shifts), NUMERIC -> number, BIGINT -> number
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool(
  config.db.url
    ? { connectionString: config.db.url }
    : {
        host: config.db.host,
        port: config.db.port,
        database: config.db.name,
        user: config.db.user,
        password: config.db.password,
      }
);

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

async function query(text, params) {
  const result = await pool.query(text, params);
  return { ...result, rows: result.rows.map(camelize) };
}

// Run several queries in one transaction: await withTransaction(async (q) => { await q(sql, params) })
async function withTransaction(fn) {
  const client = await pool.connect();
  const q = async (text, params) => {
    const result = await client.query(text, params);
    return { ...result, rows: result.rows.map(camelize) };
  };
  try {
    await client.query('BEGIN');
    const out = await fn(q);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
