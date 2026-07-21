const { Pool } = require('pg');

// Works with Supabase or Neon connection strings out of the box.
// Set DATABASE_URL in your Render environment variables.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

module.exports = pool;
