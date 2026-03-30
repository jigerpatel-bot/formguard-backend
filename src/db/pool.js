const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Fallback to individual env vars if no connection string
  ...(process.env.DATABASE_URL ? {} : {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'formguard',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
  }),
  max: 20,                  // max pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

// Helper: run a query
const query = (text, params) => pool.query(text, params);

// Helper: get a client for transactions
const getClient = () => pool.connect();

module.exports = { pool, query, getClient };
