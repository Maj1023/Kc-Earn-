'use strict';

const { getAfricanCountry } = require('./african-countries');

async function insertRegisteredUser(pool, {
  fullName,
  email,
  passwordHash,
  countryCode = 'NG'
}) {
  // Currency is derived from the trusted country catalogue. Never accept a
  // client-supplied currency that could mismatch the customer's country.
  const country = getAfricanCountry(countryCode);
  if (!country) {
    throw new TypeError('A valid African country is required.');
  }

  return pool.query(
    `INSERT INTO users (full_name, email, password_hash, country_code, currency, role)
     VALUES ($1, $2, $3, $4, $5, 'user')
     RETURNING id, full_name, email, country_code, currency, role, created_at`,
    [fullName, email, passwordHash, country.code, country.currency]
  );
}

// Create the account, both wallet records and the initial session atomically.
// A partial registration must never leave a customer with an unusable account.
async function registerAccount(pool, {
  fullName,
  email,
  passwordHash,
  countryCode = 'NG',
  tokenHash,
  expiresAt
}) {
  if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new TypeError('A valid session token hash is required.');
  }
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
    throw new TypeError('A valid session expiration is required.');
  }

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const result = await insertRegisteredUser(client, {
      fullName,
      email,
      passwordHash,
      countryCode
    });
    const user = result.rows[0];

    await client.query(
      'INSERT INTO wallets (user_id) VALUES ($1)',
      [user.id]
    );
    await client.query(
      'INSERT INTO wallet_accounts (user_id, currency) VALUES ($1, $2)',
      [user.id, user.currency]
    );
    await client.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [tokenHash, user.id, expiresAt]
    );

    await client.query('COMMIT');
    committed = true;
    return user;
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw new Error(
          'Account registration failed and rollback could not be confirmed.'
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { insertRegisteredUser, registerAccount };
