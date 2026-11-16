const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { handleOfferzyPostback } = require('./offerzy');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: true },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false
});

pool.on('error', error => {
  console.error('Unexpected idle database connection error:', error.message);
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

  // ADMIN_EMAIL role migration
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user'
  `);

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_role_check'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('user', 'admin'));
      END IF;
    END $$;
  `);

  const adminEmail = String(process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();

  if (adminEmail) {
    await pool.query(
      `UPDATE users
       SET role = 'admin'
       WHERE lower(email) = $1
         AND role <> 'admin'`,
      [adminEmail]
    );

    const adminCheck = await pool.query(
      'SELECT id FROM users WHERE lower(email) = $1',
      [adminEmail]
    );

    console.log(
      adminCheck.rowCount === 1
        ? 'Configured administrator account found.'
        : 'WARNING: ADMIN_EMAIL does not match an existing account yet.'
    );
  } else {
    console.log('ADMIN_EMAIL is not configured.');
  }

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance_kobo BIGINT NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_type VARCHAR(10) NOT NULL
        CHECK (transaction_type IN ('credit', 'debit')),
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
      description VARCHAR(255) NOT NULL,
      reference VARCHAR(100) UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS wallet_transactions_user_id_idx
    ON wallet_transactions(user_id, created_at DESC)
  `);

  await pool.query(`
    INSERT INTO wallets (user_id)
    SELECT id FROM users
    ON CONFLICT (user_id) DO NOTHING
  `);



  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 20000),
      bank_name VARCHAR(100) NOT NULL,
      account_number CHAR(10) NOT NULL,
      account_name VARCHAR(100) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
      reference VARCHAR(100) UNIQUE NOT NULL,
      admin_note VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Update the existing withdrawal minimum to ₦200.
  await pool.query(`
    ALTER TABLE withdrawal_requests
      DROP CONSTRAINT IF EXISTS withdrawal_requests_amount_kobo_check;

    ALTER TABLE withdrawal_requests
      ADD CONSTRAINT withdrawal_requests_amount_kobo_check
      CHECK (amount_kobo >= 20000);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
      ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS paid_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(100)
  `);

  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'withdrawal_requests_status_check'
          AND conrelid = 'withdrawal_requests'::regclass
          AND pg_get_constraintdef(oid) NOT LIKE '%paid%'
      ) THEN
        ALTER TABLE withdrawal_requests
          DROP CONSTRAINT withdrawal_requests_status_check;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'withdrawal_requests_status_check'
          AND conrelid = 'withdrawal_requests'::regclass
      ) THEN
        ALTER TABLE withdrawal_requests
          ADD CONSTRAINT withdrawal_requests_status_check
          CHECK (status IN ('pending', 'approved', 'rejected', 'paid'));
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS withdrawal_requests_user_id_idx
    ON withdrawal_requests(user_id, created_at DESC)
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS reward_settings (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      user_reward_percent SMALLINT NOT NULL DEFAULT 0
        CHECK (user_reward_percent BETWEEN 0 AND 100),
      rewards_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO reward_settings (id, user_reward_percent, rewards_enabled)
    VALUES (1, 0, FALSE)
    ON CONFLICT (id) DO NOTHING
  `);

  // Admin-controlled USD to NGN conversion rate for Offerzy rewards.
  // Zero keeps reward calculations disabled until explicitly configured.
  await pool.query(`
    ALTER TABLE reward_settings
    ADD COLUMN IF NOT EXISTS usd_to_ngn_rate NUMERIC(20,4)
    NOT NULL DEFAULT 0.0000
    CHECK (usd_to_ngn_rate >= 0)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reward_settings_audit (
      id BIGSERIAL PRIMARY KEY,
      old_reward_percent SMALLINT NOT NULL,
      new_reward_percent SMALLINT NOT NULL,
      old_rewards_enabled BOOLEAN NOT NULL,
      new_rewards_enabled BOOLEAN NOT NULL,
      changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Preserve exchange-rate history, including existing audit records.
  await pool.query(`
    ALTER TABLE reward_settings_audit
    ADD COLUMN IF NOT EXISTS old_usd_to_ngn_rate NUMERIC(20,4)
    NOT NULL DEFAULT 0.0000
  `);

  await pool.query(`
    ALTER TABLE reward_settings_audit
    ADD COLUMN IF NOT EXISTS new_usd_to_ngn_rate NUMERIC(20,4)
    NOT NULL DEFAULT 0.0000
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_conversations (
      id BIGSERIAL PRIMARY KEY,
      user_one_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_two_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (user_one_id < user_two_id),
      UNIQUE (user_one_id, user_two_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL
        REFERENCES message_conversations(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body VARCHAR(1000) NOT NULL
        CHECK (length(btrim(body)) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION kc_earn_validate_message_participant()
    RETURNS TRIGGER AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM message_conversations c
        WHERE c.id = NEW.conversation_id
          AND (
            c.user_one_id = NEW.sender_id
            OR c.user_two_id = NEW.sender_id
          )
      ) THEN
        RAISE EXCEPTION 'Message sender must belong to the conversation';
      END IF;

      RETURN NEW;
    END;
    $function$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'messages_sender_participant_trigger'
          AND tgrelid = 'messages'::regclass
      ) THEN
        CREATE TRIGGER messages_sender_participant_trigger
        BEFORE INSERT OR UPDATE ON messages
        FOR EACH ROW
        EXECUTE FUNCTION kc_earn_validate_message_participant();
      END IF;
    END;
    $migration$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
    ON messages(conversation_id, created_at DESC, id DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS messages_unread_idx
    ON messages(conversation_id, sender_id, read_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS message_conversations_user_one_idx
    ON message_conversations(user_one_id, updated_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS message_conversations_user_two_idx
    ON message_conversations(user_two_id, updated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_blocks (
      blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id),
      CHECK (blocker_id <> blocked_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reason VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (reporter_id, message_id),
      CHECK (length(btrim(reason)) BETWEEN 1 AND 500)
    )
  `);

  await pool.query(`
    ALTER TABLE message_reports
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending'
  `);

  await pool.query(`
    ALTER TABLE message_reports
    ADD COLUMN IF NOT EXISTS reviewed_by BIGINT
    REFERENCES users(id) ON DELETE SET NULL
  `);

  await pool.query(`
    ALTER TABLE message_reports
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ
  `);

  await pool.query(`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'message_reports_status_check'
          AND conrelid = 'message_reports'::regclass
      ) THEN
        ALTER TABLE message_reports
        ADD CONSTRAINT message_reports_status_check
        CHECK (status IN ('pending', 'reviewed'));
      END IF;
    END;
    $migration$;
  `);


  // Verified Offerzy callback records and wallet accounting.
  // Wallet credits, reversals, and debt recovery are recorded transactionally.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offerzy_postbacks (
      id BIGSERIAL PRIMARY KEY,
      transaction_id VARCHAR(150) NOT NULL,
      status SMALLINT NOT NULL CHECK (status IN (1, 2)),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reward_coins NUMERIC(30,10) NOT NULL,
      payout_usd NUMERIC(20,8) NOT NULL,
      offer_id VARCHAR(150) NOT NULL,
      offer_name VARCHAR(255),
      ip VARCHAR(64),
      country VARCHAR(32),
      sub1 VARCHAR(255),
      sub2 VARCHAR(255),
      sub3 VARCHAR(255),
      sub4 VARCHAR(255),
      sub5 VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT offerzy_postbacks_transaction_status_unique
        UNIQUE (transaction_id, status)
    )
  `);

  // Preserve the financial calculation and reversal accounting for each callback.
  await pool.query(`
    ALTER TABLE offerzy_postbacks
      ADD COLUMN IF NOT EXISTS usd_to_ngn_rate NUMERIC(20,4),
      ADD COLUMN IF NOT EXISTS user_reward_percent SMALLINT
        CHECK (user_reward_percent BETWEEN 0 AND 100),
      ADD COLUMN IF NOT EXISTS calculated_reward_kobo BIGINT,
      ADD COLUMN IF NOT EXISTS wallet_credit_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (wallet_credit_kobo >= 0),
      ADD COLUMN IF NOT EXISTS recovery_applied_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_applied_kobo >= 0),
      ADD COLUMN IF NOT EXISTS wallet_debit_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (wallet_debit_kobo >= 0),
      ADD COLUMN IF NOT EXISTS recovery_added_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_added_kobo >= 0),
      ADD COLUMN IF NOT EXISTS recovery_restored_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_restored_kobo >= 0)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS offerzy_postbacks_user_created_idx
    ON offerzy_postbacks(user_id, created_at DESC)
  `);

  // Track Offerzy reversal recovery separately from available wallet funds.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offerzy_recovery_accounts (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      outstanding_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (outstanding_kobo >= 0),
      total_recovered_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (total_recovered_kobo >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Auditable history of Offerzy recovery debt movements.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offerzy_recovery_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      postback_id BIGINT NOT NULL REFERENCES offerzy_postbacks(id)
        ON DELETE RESTRICT,
      reference VARCHAR(100) NOT NULL UNIQUE,
      event_type VARCHAR(20) NOT NULL
        CHECK (event_type IN ('debt_added', 'debt_repaid', 'debt_restored')),
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS offerzy_recovery_ledger_user_created_idx
    ON offerzy_recovery_ledger(user_id, created_at DESC)
  `);

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
    `SELECT users.id, users.full_name, users.email, users.created_at, users.role
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
     AND sessions.expires_at > NOW()`,
    [hashToken(token)]
  );

  return result.rows[0] || null;
}

async function requireAdmin(req, res) {
  const user = await getLoggedInUser(req);

  if (!user) {
    sendJson(res, 401, { error: 'Please log in first.' });
    return null;
  }

  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'Administrator access required.' });
    return null;
  }

  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    isAdmin: user.role === 'admin',
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
    // Protect browser API requests against cross-site request forgery.
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      const host = req.headers.host;
      const forwardedProto = String(
        req.headers['x-forwarded-proto'] || 'http'
      ).split(',')[0].trim();

      const expectedOrigin = process.env.APP_ORIGIN ||
        (host ? forwardedProto + '://' + host : '');

      let originMatches = false;

      try {
        originMatches = Boolean(
          origin &&
          expectedOrigin &&
          new URL(origin).origin === new URL(expectedOrigin).origin
        );
      } catch {
        originMatches = false;
      }

      if (!originMatches) {
        return sendJson(res, 403, {
          error: 'Request origin not allowed.'
        });
      }
    }

    // Signed server-to-server Offerzy conversion and reversal callbacks.
    if (req.method === 'GET' &&
        pathname === '/api/offerzy/postback') {
      const callback = await handleOfferzyPostback({
        params: new URL(req.url, 'http://localhost').searchParams,
        pool,
        privateKey: process.env.OFFERZY_PRIVATE_KEY
      });

      res.writeHead(callback.status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(callback.body);
    }

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

      await pool.query(
        'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [user.id]
      );

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


    if (req.method === 'GET' && pathname === '/api/wallet') {
      const user = await getLoggedInUser(req);

      if (!user) {
        return sendJson(res, 401, {
          error: 'Please sign in.'
        });
      }

      await pool.query(
        'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [user.id]
      );

      const result = await pool.query(
        `SELECT balance_kobo::text AS balance_kobo,
                (balance_kobo / 100.0)::numeric(20,2)::text AS balance_naira
         FROM wallets
         WHERE user_id = $1`,
        [user.id]
      );

      const wallet = result.rows[0];

      return sendJson(res, 200, {
        wallet: {
          balanceKobo: wallet.balance_kobo,
          balanceNaira: wallet.balance_naira,
          currency: 'NGN'
        }
      });
    }

    if (req.method === 'GET' && pathname === '/api/wallet/transactions') {
      const user = await getLoggedInUser(req);

      if (!user) {
        return sendJson(res, 401, {
          error: 'Please sign in.'
        });
      }

      const result = await pool.query(
        `SELECT id, transaction_type, amount_kobo::text AS amount_kobo,
                (amount_kobo / 100.0)::numeric(20,2)::text AS amount_naira,
                description, reference, created_at
         FROM wallet_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [user.id]
      );

      return sendJson(res, 200, {
        transactions: result.rows.map(transaction => ({
          id: transaction.id,
          type: transaction.transaction_type,
          amountKobo: transaction.amount_kobo,
          amountNaira: transaction.amount_naira,
          description: transaction.description,
          reference: transaction.reference,
          createdAt: transaction.created_at
        }))
      });
    }



    if (req.method === 'GET' && pathname === '/api/admin/reward-settings') {
      const admin = await requireAdmin(req, res);

      if (!admin) {
        return;
      }

      const result = await pool.query(
        `SELECT user_reward_percent, rewards_enabled,
                usd_to_ngn_rate::text AS usd_to_ngn_rate, updated_at
         FROM reward_settings
         WHERE id = 1`
      );

      if (result.rowCount !== 1) {
        return sendJson(res, 500, {
          error: 'Reward settings are not initialized.'
        });
      }

      return sendJson(res, 200, {
        settings: {
          userRewardPercent: result.rows[0].user_reward_percent,
          usdToNgnRate: result.rows[0].usd_to_ngn_rate,
          rewardsEnabled: result.rows[0].rewards_enabled,
          updatedAt: result.rows[0].updated_at
        }
      });
    }

    if (req.method === 'POST' && pathname === '/api/admin/reward-settings') {
      const admin = await requireAdmin(req, res);

      if (!admin) {
        return;
      }

      const body = await readJson(req);

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, {
          error: 'Request body must be a JSON object.'
        });
      }

      const percentage = body.userRewardPercent;

      if (typeof percentage !== 'number' ||
          !Number.isInteger(percentage) ||
          percentage < 0 || percentage > 100) {
        return sendJson(res, 400, {
          error: 'Reward percentage must be a whole number from 0 to 100.'
        });
      }

      const exchangeRate = body.usdToNgnRate;

      if (typeof exchangeRate !== 'string' ||
          !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,4})?$/.test(exchangeRate) ||
          Number(exchangeRate) > 1000000) {
        return sendJson(res, 400, {
          error: 'Enter a valid USD-to-NGN rate with up to four decimal places.'
        });
      }

      if (typeof body.rewardsEnabled !== 'boolean') {
        return sendJson(res, 400, {
          error: 'Rewards enabled must be true or false.'
        });
      }

      const rewardsEnabled = body.rewardsEnabled;

      if (rewardsEnabled &&
          (percentage === 0 || Number(exchangeRate) <= 0)) {
        return sendJson(res, 400, {
          error: 'Set a positive reward percentage and exchange rate before enabling rewards.'
        });
      }

      const client = await pool.connect();
      let committed = false;

      try {
        await client.query('BEGIN');

        const current = await client.query(
          `SELECT user_reward_percent, rewards_enabled,
                  usd_to_ngn_rate::text AS usd_to_ngn_rate
           FROM reward_settings
           WHERE id = 1
           FOR UPDATE`
        );

        if (current.rowCount !== 1) {
          throw new Error('Reward settings are not initialized.');
        }

        const oldSettings = current.rows[0];
        const changed =
          Number(oldSettings.user_reward_percent) !== percentage ||
          Number(oldSettings.usd_to_ngn_rate) !== Number(exchangeRate) ||
          oldSettings.rewards_enabled !== rewardsEnabled;

        if (changed) {
          await client.query(
            `UPDATE reward_settings
             SET user_reward_percent = $1,
                 usd_to_ngn_rate = $2,
                 rewards_enabled = $3,
                 updated_by = $4,
                 updated_at = NOW()
             WHERE id = 1`,
            [percentage, exchangeRate, rewardsEnabled, admin.id]
          );

          await client.query(
            `INSERT INTO reward_settings_audit
             (old_reward_percent, new_reward_percent,
              old_rewards_enabled, new_rewards_enabled,
              old_usd_to_ngn_rate, new_usd_to_ngn_rate, changed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              oldSettings.user_reward_percent,
              percentage,
              oldSettings.rewards_enabled,
              rewardsEnabled,
              oldSettings.usd_to_ngn_rate,
              exchangeRate,
              admin.id
            ]
          );
        }

        await client.query('COMMIT');
        committed = true;

        return sendJson(res, 200, {
          message: changed
            ? 'Reward settings updated. Rewards are ' +
              (rewardsEnabled ? 'enabled.' : 'disabled.')
            : 'Reward settings are unchanged.',
          settings: {
            userRewardPercent: percentage,
            usdToNgnRate: exchangeRate,
            rewardsEnabled
          }
        });
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === 'GET' && pathname === '/api/admin/withdrawals') {
      const admin = await requireAdmin(req, res);

      if (!admin) {
        return;
      }

      const result = await pool.query(
        `SELECT wr.id, wr.user_id, users.full_name, users.email,
                wr.amount_kobo::text AS amount_kobo,
                wr.bank_name, wr.account_number, wr.account_name,
                wr.status, wr.reference, wr.admin_note,
                wr.created_at, wr.reviewed_at, wr.paid_at,
                wr.payment_reference
         FROM withdrawal_requests wr
         JOIN users ON users.id = wr.user_id
         ORDER BY
           CASE WHEN wr.status = 'pending' THEN 0 ELSE 1 END,
           wr.created_at ASC
         LIMIT 100`
      );

      return sendJson(res, 200, {
        withdrawals: result.rows.map(item => ({
          id: item.id,
          userId: item.user_id,
          userName: item.full_name,
          userEmail: item.email,
          amountKobo: item.amount_kobo,
          amountNaira: (Number(item.amount_kobo) / 100).toFixed(2),
          bankName: item.bank_name,
          accountNumber: item.account_number.trim(),
          accountName: item.account_name,
          status: item.status,
          reference: item.reference,
          adminNote: item.admin_note,
          createdAt: item.created_at,
          reviewedAt: item.reviewed_at,
          paidAt: item.paid_at,
          paymentReference: item.payment_reference
        }))
      });
    }


    const adminWithdrawalAction = pathname.match(
      /^\/api\/admin\/withdrawals\/(\d+)\/(approve|reject|paid)$/
    );

    if (req.method === 'POST' && adminWithdrawalAction) {
      const admin = await requireAdmin(req, res);

      if (!admin) {
        return;
      }

      const withdrawalId = adminWithdrawalAction[1];
      const action = adminWithdrawalAction[2];
      const body = await readJson(req);

      const adminNote = typeof body.adminNote === 'string'
        ? body.adminNote.trim()
        : '';

      if (adminNote.length > 255) {
        return sendJson(res, 400, {
          error: 'Admin note must not exceed 255 characters.'
        });
      }

      const paymentReference = typeof body.paymentReference === 'string'
        ? body.paymentReference.trim()
        : '';

      if (action === 'paid' &&
          (!paymentReference || paymentReference.length > 100)) {
        return sendJson(res, 400, {
          error: 'Enter a valid payment reference.'
        });
      }

      const client = await pool.connect();
      let committed = false;

      try {
        await client.query('BEGIN');

        const result = await client.query(
          `SELECT id, user_id, amount_kobo::text AS amount_kobo,
                  status, reference
           FROM withdrawal_requests
           WHERE id = $1
           FOR UPDATE`,
          [withdrawalId]
        );

        if (result.rowCount === 0) {
          await client.query('ROLLBACK');
          return sendJson(res, 404, {
            error: 'Withdrawal request not found.'
          });
        }

        const withdrawal = result.rows[0];

        if (String(withdrawal.user_id) === String(admin.id)) {
          await client.query('ROLLBACK');
          return sendJson(res, 403, {
            error: 'You cannot review your own withdrawal request.'
          });
        }

        if (action === 'approve' || action === 'reject') {
          if (withdrawal.status !== 'pending') {
            await client.query('ROLLBACK');
            return sendJson(res, 409, {
              error: 'Only pending withdrawals can be reviewed.'
            });
          }

          if (action === 'approve') {
            await client.query(
              `UPDATE withdrawal_requests
               SET status = 'approved',
                   admin_note = $1,
                   reviewed_by = $2,
                   reviewed_at = NOW(),
                   updated_at = NOW()
               WHERE id = $3`,
              [adminNote || null, admin.id, withdrawalId]
            );
          } else {
            await client.query(
              'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
              [withdrawal.user_id]
            );

            await client.query(
              'SELECT user_id FROM wallets WHERE user_id = $1 FOR UPDATE',
              [withdrawal.user_id]
            );

            await client.query(
              `UPDATE wallets
               SET balance_kobo = balance_kobo + $1,
                   updated_at = NOW()
               WHERE user_id = $2`,
              [withdrawal.amount_kobo, withdrawal.user_id]
            );

            const refundReference = 'REFUND-' + withdrawal.reference;

            await client.query(
              `INSERT INTO wallet_transactions
               (user_id, transaction_type, amount_kobo,
                description, reference)
               VALUES ($1, 'credit', $2, $3, $4)`,
              [
                withdrawal.user_id,
                withdrawal.amount_kobo,
                'Refund for rejected withdrawal',
                refundReference
              ]
            );

            await client.query(
              `UPDATE withdrawal_requests
               SET status = 'rejected',
                   admin_note = $1,
                   reviewed_by = $2,
                   reviewed_at = NOW(),
                   updated_at = NOW()
               WHERE id = $3`,
              [adminNote || null, admin.id, withdrawalId]
            );
          }
        } else {
          if (withdrawal.status !== 'approved') {
            await client.query('ROLLBACK');
            return sendJson(res, 409, {
              error: 'Only approved withdrawals can be marked as paid.'
            });
          }

          await client.query(
            `UPDATE withdrawal_requests
             SET status = 'paid',
                 payment_reference = $1,
                 paid_by = $2,
                 paid_at = NOW(),
                 updated_at = NOW()
             WHERE id = $3`,
            [paymentReference, admin.id, withdrawalId]
          );
        }

        await client.query('COMMIT');
        committed = true;

        return sendJson(res, 200, {
          message: action === 'approve'
            ? 'Withdrawal approved for manual payment.'
            : action === 'reject'
              ? 'Withdrawal rejected and wallet refunded.'
              : 'Withdrawal marked as paid.',
          status: action === 'paid' ? 'paid' : action === 'approve' ? 'approved' : 'rejected'
        });
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === 'POST' && pathname === '/api/withdrawals') {
      const user = await getLoggedInUser(req);

      if (!user) {
        return sendJson(res, 401, { error: 'Please sign in.' });
      }

      const body = await readJson(req);
      const amountText = String(body.amountNaira ?? '').trim();
      const bankName = typeof body.bankName === 'string'
        ? body.bankName.trim()
        : '';
      const accountNumber = typeof body.accountNumber === 'string'
        ? body.accountNumber.trim()
        : '';
      const accountName = typeof body.accountName === 'string'
        ? body.accountName.trim().replace(/\s+/g, ' ')
        : '';

      if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(amountText)) {
        return sendJson(res, 400, {
          error: 'Enter a valid withdrawal amount.'
        });
      }

      const amountParts = amountText.split('.');
      const amountKobo = Number(amountParts[0]) * 100 +
        Number(((amountParts[1] || '') + '00').slice(0, 2));

      if (!Number.isSafeInteger(amountKobo) || amountKobo < 20000) {
        return sendJson(res, 400, {
          error: 'Minimum withdrawal is ₦200.'
        });
      }

      const supportedBanks = new Set([
        'opay',
        'palmpay',
        'kuda',
        'moniepoint',
        'access bank',
        'first bank',
        'gtbank',
        'guaranty trust bank',
        'uba',
        'united bank for africa',
        'zenith bank',
        'fidelity bank',
        'fcmb',
        'stanbic ibtc',
        'sterling bank',
        'wema bank',
        'union bank',
        'ecobank',
        'polaris bank',
        'keystone bank',
        'providus bank',
        'jaiz bank',
        'lotus bank',
        'tajbank',
        'premium trust bank',
        'standard chartered bank',
        'globus bank'
      ]);

      if (!supportedBanks.has(bankName.toLowerCase())) {
        return sendJson(res, 400, {
          error: 'Select a supported Nigerian bank or payment provider.'
        });
      }

      if (!/^\d{10}$/.test(accountNumber)) {
        return sendJson(res, 400, {
          error: 'Account number must contain exactly 10 digits.'
        });
      }

      if (accountName.length < 2 || accountName.length > 100) {
        return sendJson(res, 400, {
          error: 'Enter the account holder name.'
        });
      }

      const client = await pool.connect();
      let committed = false;

      try {
        await client.query('BEGIN');

        await client.query(
          'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [user.id]
        );

        const walletResult = await client.query(
          'SELECT balance_kobo::text AS balance_kobo FROM wallets WHERE user_id = $1 FOR UPDATE',
          [user.id]
        );

        const balanceKobo = BigInt(walletResult.rows[0].balance_kobo);

        if (balanceKobo < BigInt(amountKobo)) {
          await client.query('ROLLBACK');
          return sendJson(res, 400, {
            error: 'Insufficient wallet balance.'
          });
        }

        const reference = 'WDR-' +
          Date.now() + '-' + crypto.randomBytes(6).toString('hex');

        await client.query(
          'UPDATE wallets SET balance_kobo = balance_kobo - $1, updated_at = NOW() WHERE user_id = $2',
          [String(amountKobo), user.id]
        );

        await client.query(
          `INSERT INTO wallet_transactions
           (user_id, transaction_type, amount_kobo, description, reference)
           VALUES ($1, 'debit', $2, $3, $4)`,
          [
            user.id,
            String(amountKobo),
            'Withdrawal request to ' + bankName,
            reference
          ]
        );

        const result = await client.query(
          `INSERT INTO withdrawal_requests
           (user_id, amount_kobo, bank_name, account_number,
            account_name, reference)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, amount_kobo::text AS amount_kobo,
             bank_name, RIGHT(account_number, 4) AS account_last4,
             account_name, status, reference, created_at`,
          [
            user.id,
            String(amountKobo),
            bankName,
            accountNumber,
            accountName,
            reference
          ]
        );

        await client.query('COMMIT');
        committed = true;

        const withdrawal = result.rows[0];

        return sendJson(res, 201, {
          message: 'Withdrawal request submitted for admin review.',
          withdrawal: {
            id: withdrawal.id,
            amountKobo: withdrawal.amount_kobo,
            amountNaira: (Number(withdrawal.amount_kobo) / 100).toFixed(2),
            bankName: withdrawal.bank_name,
            accountLast4: withdrawal.account_last4,
            accountName: withdrawal.account_name,
            status: withdrawal.status,
            reference: withdrawal.reference,
            createdAt: withdrawal.created_at
          }
        });
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === 'GET' && pathname === '/api/withdrawals') {
      const user = await getLoggedInUser(req);

      if (!user) {
        return sendJson(res, 401, { error: 'Please sign in.' });
      }

      const result = await pool.query(
        `SELECT id, amount_kobo::text AS amount_kobo,
                bank_name, RIGHT(account_number, 4) AS account_last4,
                account_name, status, reference, created_at
         FROM withdrawal_requests
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [user.id]
      );

      return sendJson(res, 200, {
        withdrawals: result.rows.map(item => ({
          id: item.id,
          amountKobo: item.amount_kobo,
          amountNaira: (Number(item.amount_kobo) / 100).toFixed(2),
          bankName: item.bank_name,
          accountLast4: item.account_last4,
          accountName: item.account_name,
          status: item.status,
          reference: item.reference,
          createdAt: item.created_at
        }))
      });
    }

    if (req.method === 'GET' && pathname === '/api/messages/users') {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const search = new URL(req.url, 'http://localhost').searchParams.get('q');
      const query = typeof search === 'string' ? search.trim() : '';

      if (query.length < 2 || query.length > 40) {
        return sendJson(res, 400, { error: 'Search must contain 2 to 40 characters.' });
      }

      const result = await pool.query(
        `SELECT u.id::text AS id, u.full_name
         FROM users u
         WHERE u.id <> $1
           AND u.full_name ILIKE $2
           AND NOT EXISTS (
             SELECT 1 FROM message_blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                OR (b.blocker_id = u.id AND b.blocked_id = $1)
           )
         ORDER BY u.full_name ASC
         LIMIT 10`,
        [user.id, query + '%']
      );

      return sendJson(res, 200, { users: result.rows });
    }

    if (req.method === 'GET' && pathname === '/api/messages/conversations') {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const result = await pool.query(
        `SELECT
           c.id::text AS id,
           other.id::text AS user_id,
           other.full_name,
           latest.body AS last_message,
           latest.created_at AS last_message_at,
           COALESCE(unread.total, 0)::int AS unread_count
         FROM message_conversations c
         JOIN users other
           ON other.id = CASE
             WHEN c.user_one_id = $1 THEN c.user_two_id
             ELSE c.user_one_id
           END
         LEFT JOIN LATERAL (
           SELECT body, created_at
           FROM messages
           WHERE conversation_id = c.id
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS total
           FROM messages
           WHERE conversation_id = c.id
             AND sender_id = other.id
             AND read_at IS NULL
         ) unread ON TRUE
         WHERE c.user_one_id = $1 OR c.user_two_id = $1
         ORDER BY COALESCE(latest.created_at, c.updated_at) DESC
         LIMIT 50`,
        [user.id]
      );

      return sendJson(res, 200, { conversations: result.rows });
    }

    if (req.method === 'POST' && pathname === '/api/messages/conversations') {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const body = await readJson(req);

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, {
          error: 'Request body must be a JSON object.'
        });
      }

      const recipientId = String(body.recipientId || '');

      if (!/^[1-9]\d{0,17}$/.test(recipientId) ||
          BigInt(recipientId) > 9223372036854775807n) {
        return sendJson(res, 400, { error: 'Invalid recipient.' });
      }

      if (BigInt(recipientId) === BigInt(user.id)) {
        return sendJson(res, 400, { error: 'You cannot message yourself.' });
      }

      const first = BigInt(user.id) < BigInt(recipientId)
        ? user.id : recipientId;
      const second = BigInt(user.id) < BigInt(recipientId)
        ? recipientId : user.id;

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['kc-earn-message-pair:' + first + ':' + second]
        );

        const recipient = await client.query(
          'SELECT id FROM users WHERE id = $1',
          [recipientId]
        );

        if (!recipient.rowCount) {
          await client.query('ROLLBACK');
          return sendJson(res, 404, { error: 'Customer not found.' });
        }

        const blocked = await client.query(
          `SELECT 1 FROM message_blocks
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)
           LIMIT 1`,
          [user.id, recipientId]
        );

        if (blocked.rowCount) {
          await client.query('ROLLBACK');
          return sendJson(res, 403, {
            error: 'Messaging is unavailable for this customer.'
          });
        }

        const result = await client.query(
          `INSERT INTO message_conversations (user_one_id, user_two_id)
           VALUES ($1, $2)
           ON CONFLICT (user_one_id, user_two_id) DO NOTHING
           RETURNING id::text AS id`,
          [first, second]
        );

        let conversationId;

        if (result.rowCount) {
          conversationId = result.rows[0].id;
        } else {
          const existing = await client.query(
            `SELECT id::text AS id
             FROM message_conversations
             WHERE user_one_id = $1 AND user_two_id = $2`,
            [first, second]
          );

          if (!existing.rowCount) {
            throw new Error('Conversation could not be created or retrieved.');
          }

          conversationId = existing.rows[0].id;
        }

        await client.query('COMMIT');

        return sendJson(res, 200, { conversationId });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const messageConversationMatch =
      pathname.match(/^\/api\/messages\/conversations\/([1-9]\d{0,17})$/);

    if (
      messageConversationMatch &&
      BigInt(messageConversationMatch[1]) <= 9223372036854775807n &&
      req.method === 'GET'
    ) {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const conversationId = messageConversationMatch[1];

      const conversation = await pool.query(
        `SELECT id, user_one_id, user_two_id
         FROM message_conversations
         WHERE id = $1 AND (user_one_id = $2 OR user_two_id = $2)`,
        [conversationId, user.id]
      );

      if (!conversation.rowCount) {
        return sendJson(res, 404, { error: 'Conversation not found.' });
      }

      await pool.query(
        `UPDATE messages
         SET read_at = NOW()
         WHERE conversation_id = $1
           AND sender_id <> $2
           AND read_at IS NULL`,
        [conversationId, user.id]
      );

      const result = await pool.query(
        `SELECT id, sender_id, sender_name, body, created_at, read_at
         FROM (
           SELECT m.id AS sort_id, m.id::text AS id,
                  m.sender_id::text AS sender_id,
                  u.full_name AS sender_name, m.body, m.created_at, m.read_at
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.conversation_id = $1
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 50
         ) recent
         ORDER BY created_at ASC, sort_id ASC`,
        [conversationId]
      );

      return sendJson(res, 200, { messages: result.rows });
    }

    if (
      messageConversationMatch &&
      BigInt(messageConversationMatch[1]) <= 9223372036854775807n &&
      req.method === 'POST'
    ) {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const conversationId = messageConversationMatch[1];
      const body = await readJson(req);

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, {
          error: 'Request body must be a JSON object.'
        });
      }

      const message = typeof body.message === 'string' ? body.message.trim() : '';

      if (!message || message.length > 1000) {
        return sendJson(res, 400, { error: 'Message must contain 1 to 1000 characters.' });
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['kc-earn-message-sender:' + user.id]
        );

        const conversation = await client.query(
          `SELECT user_one_id, user_two_id
           FROM message_conversations
           WHERE id = $1 AND (user_one_id = $2 OR user_two_id = $2)`,
          [conversationId, user.id]
        );

        if (!conversation.rowCount) {
          await client.query('ROLLBACK');
          return sendJson(res, 404, { error: 'Conversation not found.' });
        }

        const otherId = String(
          BigInt(conversation.rows[0].user_one_id) === BigInt(user.id)
            ? conversation.rows[0].user_two_id
            : conversation.rows[0].user_one_id
        );

        const lowId = BigInt(user.id) < BigInt(otherId)
          ? user.id : otherId;
        const highId = BigInt(user.id) < BigInt(otherId)
          ? otherId : user.id;

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['kc-earn-message-pair:' + lowId + ':' + highId]
        );

        const blocked = await client.query(
          `SELECT 1 FROM message_blocks
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)
           LIMIT 1`,
          [user.id, otherId]
        );

        if (blocked.rowCount) {
          await client.query('ROLLBACK');
          return sendJson(res, 403, {
            error: 'You cannot send messages in this conversation.'
          });
        }

        const recent = await client.query(
          `SELECT COUNT(*)::int AS total
           FROM messages
           WHERE sender_id = $1
             AND created_at > NOW() - INTERVAL '10 seconds'`,
          [user.id]
        );

        if (recent.rows[0].total >= 5) {
          await client.query('ROLLBACK');
          return sendJson(res, 429, {
            error: 'Please wait before sending more messages.'
          });
        }

        const result = await client.query(
          `WITH inserted AS (
             INSERT INTO messages (conversation_id, sender_id, body)
             VALUES ($1, $2, $3)
             RETURNING id::text AS id, sender_id::text AS sender_id,
                       body, created_at, read_at
           ),
           updated AS (
             UPDATE message_conversations
             SET updated_at = NOW()
             WHERE id = $1
             RETURNING id
           )
           SELECT inserted.*
           FROM inserted
           CROSS JOIN updated`,
          [conversationId, user.id, message]
        );

        if (!result.rowCount) {
          await client.query('ROLLBACK');
          return sendJson(res, 404, { error: 'Conversation not found.' });
        }

        await client.query('COMMIT');

        return sendJson(res, 201, { message: result.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === 'POST' && pathname === '/api/messages/block') {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const body = await readJson(req);

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, {
          error: 'Request body must be a JSON object.'
        });
      }

      const blockedId = String(body.userId || '');

      if (!/^[1-9]\d{0,17}$/.test(blockedId) ||
          BigInt(blockedId) > 9223372036854775807n ||
          BigInt(blockedId) === BigInt(user.id)) {
        return sendJson(res, 400, { error: 'Invalid customer.' });
      }

      const lowId = BigInt(user.id) < BigInt(blockedId)
        ? user.id : blockedId;
      const highId = BigInt(user.id) < BigInt(blockedId)
        ? blockedId : user.id;

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['kc-earn-message-pair:' + lowId + ':' + highId]
        );

        const target = await client.query(
          'SELECT id FROM users WHERE id = $1',
          [blockedId]
        );

        if (!target.rowCount) {
          await client.query('ROLLBACK');
          return sendJson(res, 404, { error: 'Customer not found.' });
        }

        await client.query(
          `INSERT INTO message_blocks (blocker_id, blocked_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [user.id, blockedId]
        );

        await client.query('COMMIT');

        return sendJson(res, 200, { message: 'Customer blocked.' });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === 'POST' && pathname === '/api/messages/report') {
      const user = await getLoggedInUser(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

      const body = await readJson(req);

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, {
          error: 'Request body must be a JSON object.'
        });
      }

      const messageId = String(body.messageId || '');
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      if (!/^[1-9]\d{0,17}$/.test(messageId) ||
          BigInt(messageId) > 9223372036854775807n ||
          !reason || reason.length > 500) {
        return sendJson(res, 400, { error: 'Please provide a valid message and report reason.' });
      }

      const reported = await pool.query(
        `SELECT m.id
         FROM messages m
         JOIN message_conversations c ON c.id = m.conversation_id
         WHERE m.id = $1
           AND m.sender_id <> $2
           AND (c.user_one_id = $2 OR c.user_two_id = $2)`,
        [messageId, user.id]
      );

      if (!reported.rowCount) {
        return sendJson(res, 404, { error: 'Reportable message not found.' });
      }

      const result = await pool.query(
        `INSERT INTO message_reports (reporter_id, message_id, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (reporter_id, message_id) DO NOTHING
         RETURNING id`,
        [user.id, messageId, reason]
      );

      if (!result.rowCount) {
        return sendJson(res, 409, { error: 'You have already reported this message.' });
      }

      return sendJson(res, 201, { message: 'Report submitted.' });
    }

    if (req.method === 'GET' && pathname === '/api/admin/message-reports') {
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      const result = await pool.query(
        `SELECT
           mr.id::text AS id,
           mr.reason,
           mr.status,
           mr.created_at,
           mr.reviewed_at,
           reporter.full_name AS reporter_name,
           sender.full_name AS sender_name,
           sender.id::text AS sender_id,
           m.body AS message_body,
           m.created_at AS message_created_at,
           reviewer.full_name AS reviewer_name
         FROM message_reports mr
         JOIN users reporter ON reporter.id = mr.reporter_id
         JOIN messages m ON m.id = mr.message_id
         JOIN users sender ON sender.id = m.sender_id
         LEFT JOIN users reviewer ON reviewer.id = mr.reviewed_by
         ORDER BY
           CASE WHEN mr.status = 'pending' THEN 0 ELSE 1 END,
           mr.created_at DESC
         LIMIT 100`
      );

      return sendJson(res, 200, { reports: result.rows });
    }

    const messageReportReviewMatch =
      pathname.match(/^\/api\/admin\/message-reports\/([1-9]\d{0,17})\/review$/);

    if (
      messageReportReviewMatch &&
      BigInt(messageReportReviewMatch[1]) <= 9223372036854775807n &&
      req.method === 'POST'
    ) {
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      const reportId = messageReportReviewMatch[1];

      const result = await pool.query(
        `UPDATE message_reports
         SET status = 'reviewed',
             reviewed_by = $2,
             reviewed_at = NOW()
         WHERE id = $1
           AND status = 'pending'
         RETURNING id::text AS id, status, reviewed_at`,
        [reportId, admin.id]
      );

      if (!result.rowCount) {
        const existing = await pool.query(
          'SELECT status FROM message_reports WHERE id = $1',
          [reportId]
        );

        if (!existing.rowCount) {
          return sendJson(res, 404, { error: 'Message report not found.' });
        }

        return sendJson(res, 409, { error: 'This report has already been reviewed.' });
      }

      return sendJson(res, 200, {
        message: 'Report marked as reviewed.',
        report: result.rows[0]
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

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(signal + ' received. Shutting down KC Earn.');

  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10000);

  forceExit.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });

    await pool.end();
    clearTimeout(forceExit);
    console.log('KC Earn shut down cleanly.');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error('Shutdown error:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initializeDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`KC Earn API running on port ${PORT}`);
    });
  })
  .catch(async error => {
    console.error('Database initialization failed:', error.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
