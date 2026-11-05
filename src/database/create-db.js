// Creates the database named in DATABASE_URL / DB_NAME if it does not exist yet.
require('dotenv').config();
const { Client } = require('pg');

function target() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      name: u.pathname.replace('/', ''),
    };
  }
  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
  };
}

(async () => {
  const t = target();
  if (!/^[A-Za-z0-9_]+$/.test(t.name || '')) {
    console.error('Database name must contain only letters, numbers and underscores.');
    process.exit(1);
  }
  const client = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: 'postgres',
  });
  try {
    await client.connect();
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [t.name]);
    if (rowCount) {
      console.log(`Database "${t.name}" already exists.`);
    } else {
      await client.query(`CREATE DATABASE "${t.name}"`);
      console.log(`Database "${t.name}" created.`);
    }
  } catch (err) {
    console.error('Could not create database:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
