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

module.exports = { insertRegisteredUser };
