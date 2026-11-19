'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { insertRegisteredUser } = require('../server/account-registration');

test('ordinary registration always writes the user role', async () => {
  let recordedQuery;
  const pool = {
    async query(sql, values) {
      recordedQuery = { sql: sql.replace(/\s+/g, ' ').trim(), values };
      return { rowCount: 1, rows: [{ id: '12' }] };
    }
  };

  await insertRegisteredUser(pool, {
    fullName: 'Test User',
    email: 'user@example.test',
    passwordHash: 'test-hash',
    role: 'admin'
  });

  assert.match(recordedQuery.sql, /VALUES \(\$1, \$2, \$3, 'user'\)/);
  assert.match(recordedQuery.sql, /RETURNING id, full_name, email, role, created_at/);
  assert.deepEqual(recordedQuery.values, [
    'Test User',
    'user@example.test',
    'test-hash'
  ]);
});
