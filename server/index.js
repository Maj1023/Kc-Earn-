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
  ssl: { rejectUnauthorized: true },
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
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 150000),
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

      if (!Number.isSafeInteger(amountKobo) || amountKobo < 150000) {
        return sendJson(res, 400, {
          error: 'Minimum withdrawal is ₦1,500.'
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
