'use strict';

async function insertRegisteredUser(pool, { fullName, email, passwordHash, countryCode = 'NG', currency = 'NGN' }) {
  return pool.query(
    `INSERT INTO users (full_name, email, password_hash, country_code, currency, role)
     VALUES ($1, $2, $3, $4, $5, 'user')
     RETURNING id, full_name, email, country_code, currency, role, created_at`,
    [fullName, email, passwordHash, countryCode, currency]
  );
}

module.exports = { insertRegisteredUser };
