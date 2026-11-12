const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('KC Earn database connected. Users table ready.');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      await pool.query('SELECT 1');

      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        service: 'KC Earn API',
        database: 'connected'
      }));
    } catch (error) {
      console.error('Database health check failed:', error.message);
      res.writeHead(503);
      res.end(JSON.stringify({
        status: 'error',
        service: 'KC Earn API',
        database: 'disconnected'
      }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: 'Route not found'
  }));
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`KC Earn API running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
