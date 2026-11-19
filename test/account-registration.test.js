'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { insertRegisteredUser } = require('../server/account-registration');

async function captureInsert(input) {
  let recordedQuery;
  const pool = {
    async query(sql, values) {
      recordedQuery = { sql: sql.replace(/\s+/g, ' ').trim(), values };
      return { rowCount: 1, rows: [{ id: '12' }] };
    }
  };
  await insertRegisteredUser(pool, input);
  return recordedQuery;
}

test('registration derives the account currency from the selected country', async () => {
  const query = await captureInsert({
    fullName: 'Test User',
    email: 'user@example.test',
    passwordHash: 'test-hash',
    countryCode: 'ke',
    currency: 'NGN',
    role: 'admin'
  });

  assert.match(query.sql, /INSERT INTO users \(full_name, email, password_hash, country_code, currency, role\)/);
  assert.match(query.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, 'user'\)/);
  assert.deepEqual(query.values, ['Test User', 'user@example.test', 'test-hash', 'KE', 'KES']);
});

test('registration preserves Nigerian defaults for existing callers', async () => {
  const query = await captureInsert({
    fullName: 'Nigeria User',
    email: 'ng@example.test',
    passwordHash: 'test-hash'
  });
  assert.deepEqual(query.values, ['Nigeria User', 'ng@example.test', 'test-hash', 'NG', 'NGN']);
});

test('registration rejects country codes outside the African country catalogue', async () => {
  let calls = 0;
  const pool = { async query() { calls += 1; } };
  await assert.rejects(
    insertRegisteredUser(pool, {
      fullName: 'Invalid User',
      email: 'invalid@example.test',
      passwordHash: 'test-hash',
      countryCode: 'XX'
    }),
    { name: 'TypeError', message: 'A valid African country is required.' }
  );
  assert.equal(calls, 0);
});
