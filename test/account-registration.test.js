'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { insertRegisteredUser, registerAccount } = require('../server/account-registration');

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


function makeRegistrationPool({ failOn } = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (failOn && sql.includes(failOn)) {
        const error = new Error('simulated database failure');
        error.code = 'XX000';
        throw error;
      }
      if (sql.includes('INSERT INTO users')) {
        return {
          rowCount: 1,
          rows: [{
            id: '42',
            full_name: 'Test User',
            email: 'user@example.test',
            country_code: 'KE',
            currency: 'KES',
            role: 'user'
          }]
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {
      released = true;
    }
  };

  return {
    pool: {
      async connect() {
        return client;
      }
    },
    queries,
    wasReleased: () => released
  };
}

test('creates user, both wallets and session in one transaction', async () => {
  const fake = makeRegistrationPool();
  const user = await registerAccount(fake.pool, {
    fullName: 'Test User',
    email: 'user@example.test',
    passwordHash: 'test-hash',
    countryCode: 'KE',
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date('2027-01-01T00:00:00.000Z')
  });

  assert.equal(user.id, '42');
  assert.equal(user.currency, 'KES');
  assert.equal(fake.queries[0].sql, 'BEGIN');
  assert.ok(fake.queries.some(q => q.sql.includes('INSERT INTO wallets')));
  assert.ok(fake.queries.some(q => q.sql.includes('INSERT INTO wallet_accounts')));
  assert.ok(fake.queries.some(q => q.sql.includes('INSERT INTO sessions')));
  assert.equal(fake.queries.at(-1).sql, 'COMMIT');
  assert.equal(fake.wasReleased(), true);
});

test('rolls back a partially-created account if wallet setup fails', async () => {
  const fake = makeRegistrationPool({ failOn: 'INSERT INTO wallet_accounts' });

  await assert.rejects(
    registerAccount(fake.pool, {
      fullName: 'Test User',
      email: 'user@example.test',
      passwordHash: 'test-hash',
      countryCode: 'KE',
      tokenHash: 'b'.repeat(64),
      expiresAt: new Date('2027-01-01T00:00:00.000Z')
    }),
    /simulated database failure/
  );

  assert.ok(fake.queries.some(q => q.sql === 'ROLLBACK'));
  assert.ok(!fake.queries.some(q => q.sql === 'COMMIT'));
  assert.equal(fake.wasReleased(), true);
});

test('rejects invalid session data before opening a database connection', async () => {
  let connections = 0;
  const pool = { async connect() { connections += 1; } };

  await assert.rejects(
    registerAccount(pool, {
      fullName: 'Test User',
      email: 'user@example.test',
      passwordHash: 'test-hash',
      countryCode: 'NG',
      tokenHash: 'not-a-hash',
      expiresAt: new Date()
    }),
    /valid session token hash/
  );
  assert.equal(connections, 0);
});
