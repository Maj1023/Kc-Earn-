const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx
    ON sessions(user_id)
  `);

  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');

  console.log('KC Earn database and account tables ready.');
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (Buffer.byteLength(body) > 10000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');

  for (const cookie of cookies) {
    const parts = cookie.trim().split('=');

    if (parts[0] === name) {
      return parts.slice(1).join('=');
    }
  }

  return null;
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MS);

  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, userId, expiresAt]
  );

  res.setHeader('Set-Cookie',
    `kc_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`
  );
}

async function getLoggedInUser(req) {
  const token = getCookie(req, 'kc_session');

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }

  const result = await pool.query(
    `SELECT users.id, users.full_name, users.email, users.created_at
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
     AND sessions.expires_at > NOW()`,
    [hashToken(token)]
  );

  return result.rows[0] || null;
}

function publicUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    createdAt: user.created_at
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');

  const pathname = new URL(req.url, 'http://localhost').pathname;

  try {
    if (req.method === 'GET' &&
        (pathname === '/' || pathname === '/index.html')) {
      fs.readFile(path.join(__dirname, '../public/index.html'), (error, data) => {
        if (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('KC Earn homepage could not be loaded.');
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(data);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      await pool.query('SELECT 1');
      return sendJson(res, 200, {
        status: 'ok',
        service: 'KC Earn API',
        database: 'connected'
      });
    }

    if (req.method === 'POST' && pathname === '/api/register') {
      const body = await readJson(req);
      const fullName = typeof body.fullName === 'string'
        ? body.fullName.trim().replace(/\s+/g, ' ')
        : '';
      const email = typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';
      const password = typeof body.password === 'string'
        ? body.password
        : '';

      if (fullName.length < 2 || fullName.length > 100) {
        return sendJson(res, 400, {
          error: 'Enter a name between 2 and 100 characters.'
        });
      }

      if (email.length > 255 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, {
          error: 'Enter a valid email address.'
        });
      }

      if (password.length < 8 ||
          Buffer.byteLength(password, 'utf8') > 72) {
        return sendJson(res, 400, {
          error: 'Password must be at least 8 characters and no more than 72 bytes.'
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      let result;

      try {
        result = await pool.query(
          `INSERT INTO users (full_name, email, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, full_name, email, created_at`,
          [fullName, email, passwordHash]
        );
      } catch (error) {
        if (error.code === '23505') {
          return sendJson(res, 409, {
            error: 'An account with this email already exists.'
          });
        }
        throw error;
      }

      const user = result.rows[0];
      await createSession(user.id, res);

      return sendJson(res, 201, {
        message: 'Account created successfully.',
        user: publicUser(user)
      });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJson(req);
      const email = typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';
      const password = typeof body.password === 'string'
        ? body.password
        : '';

      if (!email || !password ||
          Buffer.byteLength(password, 'utf8') > 72) {
        return sendJson(res, 400, {
          error: 'Enter your email address and password.'
        });
      }

      const result = await pool.query(
        `SELECT id, full_name, email, password_hash, created_at
         FROM users WHERE email = $1`,
        [email]
      );

      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return sendJson(res, 401, {
          error: 'Incorrect email or password.'
        });
      }

      await createSession(user.id, res);

      return sendJson(res, 200, {
        message: 'Login successful.',
        user: publicUser(user)
      });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const user = await getLoggedInUser(req);

      if (!user) {
        return sendJson(res, 401, {
          error: 'Please sign in.'
        });
      }

      return sendJson(res, 200, {
        user: publicUser(user)
      });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = getCookie(req, 'kc_session');

      if (token && /^[a-f0-9]{64}$/.test(token)) {
        await pool.query(
          'DELETE FROM sessions WHERE token_hash = $1',
          [hashToken(token)]
        );
      }

      res.setHeader('Set-Cookie',
        'kc_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
      );

      return sendJson(res, 200, {
        message: 'Signed out successfully.'
      });
    }

    return sendJson(res, 404, { error: 'Route not found' });

  } catch (error) {
    console.error('Request error:', error.message);

    if (!res.headersSent && !res.destroyed) {
      const status = error.message === 'Invalid JSON' ? 400 :
        error.message === 'Request too large' ? 413 : 500;

      sendJson(res, status, {
        error: status === 500
          ? 'An unexpected server error occurred.'
          : error.message
      });
    }
  }
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`KC Earn API running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
