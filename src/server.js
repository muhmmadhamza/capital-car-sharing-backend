const config = require('./config/env');
const app = require('./app');
const { pool } = require('./database/pool');

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected');
  } catch (err) {
    console.error('Cannot connect to PostgreSQL:', err.message);
    console.error('Check your .env database settings and that PostgreSQL is running.');
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`Capital Car Sharing API running on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
