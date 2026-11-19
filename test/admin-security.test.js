'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const {
  ADMIN_ROLE_LOCK_SQL,
  createSessionRecord,
  getAdminAuthorizationError,
  isSessionActive,
  validateRoleChange,
  verifyCurrentPassword,
  isValidSessionToken,
  provisionAdministrator
} = require('../server/admin-security');

test('allows explicit promotion and demotion when safeguards pass', () => {
  assert.equal(
    validateRoleChange('1', 'admin', '2', 'user', 'admin', 1),
    null
  );
  assert.equal(
    validateRoleChange('1', 'admin', '2', 'admin', 'user', 2),
    null
  );
});

test('rejects invalid or unchanged role changes', () => {
  assert.match(
    validateRoleChange('1', 'admin', '2', 'user', 'owner', 1),
    /Invalid administrator role/
  );
  assert.match(
    validateRoleChange('1', 'admin', '2', 'user', 'user', 1),
    /already has/
  );
});

test('rejects self role changes and demotion of the final administrator', () => {
  assert.match(
    validateRoleChange('1', 'admin', '1', 'admin', 'user', 1),
    /cannot change their own/
  );
  assert.match(
    validateRoleChange('1', 'admin', '2', 'admin', 'user', 1),
    /final administrator/
  );
  assert.match(
    validateRoleChange('1', 'admin', '2', 'admin', 'user', 'unknown'),
    /final administrator/
  );
});

test('rejects role changes by non-administrators', () => {
  assert.match(
    validateRoleChange('1', 'user', '2', 'user', 'admin', 1),
    /Administrator access required/
  );
});

test('returns distinct login and administrator authorization failures', () => {
  assert.deepEqual(getAdminAuthorizationError(null), {
    status: 401,
    error: 'Please log in first.'
  });
  assert.deepEqual(getAdminAuthorizationError({ role: 'user' }), {
    status: 403,
    error: 'Administrator access required.'
  });
  assert.equal(getAdminAuthorizationError({ role: 'admin' }), null);
});

test('rejects expired or invalid sessions', () => {
  const now = Date.parse('2026-11-18T18:00:00.000Z');
  assert.equal(
    isSessionActive('2026-11-18T18:01:00.000Z', now),
    true
  );
  assert.equal(
    isSessionActive('2026-11-18T17:59:00.000Z', now),
    false
  );
  assert.equal(isSessionActive('not-a-date', now), false);
});

test('requires the current administrator password', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('owner-current-password', 12);

  assert.equal(
    await verifyCurrentPassword(hash, 'owner-current-password'),
    true
  );
  assert.equal(
    await verifyCurrentPassword(hash, 'wrong-password'),
    false
  );
  assert.equal(await verifyCurrentPassword(hash, ''), false);
  assert.equal(
    await verifyCurrentPassword(hash, 'x'.repeat(73)),
    false
  );
});

test('accepts only well-formed session tokens', () => {
  assert.equal(isValidSessionToken('a'.repeat(64)), true);
  assert.equal(isValidSessionToken('A'.repeat(64)), false);
  assert.equal(isValidSessionToken('a'.repeat(63)), false);
  assert.equal(isValidSessionToken(null), false);
});

function makeSessionPool({ failOn } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalizedSql, params });

      if (failOn && normalizedSql.startsWith(failOn)) {
        throw new Error('Simulated database failure.');
      }

      return normalizedSql.startsWith('SELECT id FROM users')
        ? { rowCount: 1, rows: [{ id: params[0] }] }
        : { rowCount: 1, rows: [] };
    },
    release() {
      client.released = true;
    }
  };

  return {
    client,
    queries,
    pool: {
      async connect() {
        return client;
      }
    }
  };
}

test('session creation locks its account and commits the inserted session', async () => {
  const fake = makeSessionPool();
  const expiresAt = new Date(Date.now() + 60_000);

  await createSessionRecord(fake.pool, {
    userId: '44',
    tokenHash: 'a'.repeat(64),
    expiresAt
  });

  assert.deepEqual(fake.queries, [
    { sql: 'BEGIN', params: [] },
    {
      sql: 'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      params: ['44']
    },
    {
      sql: 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      params: ['a'.repeat(64), '44', expiresAt]
    },
    { sql: 'COMMIT', params: [] }
  ]);
  assert.equal(fake.client.released, true);
});

test('session creation rolls back when inserting the session fails', async () => {
  const fake = makeSessionPool({
    failOn: 'INSERT INTO sessions'
  });

  await assert.rejects(
    createSessionRecord(fake.pool, {
      userId: '44',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000)
    }),
    /Simulated database failure/
  );

  assert.equal(fake.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(fake.queries.some(query => query.sql === 'COMMIT'), false);
  assert.equal(fake.client.released, true);
});

function makeProvisionPool(user, { failOn } = {}) {
  const users = Array.isArray(user) ? user : user ? [user] : [];
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalizedSql, params });

      if (failOn && normalizedSql.startsWith(failOn)) {
        throw new Error('Simulated database failure.');
      }

      if (normalizedSql.startsWith('SELECT id, role FROM users')) {
        return {
          rowCount: users.length,
          rows: users.map(target => ({
            id: target.id,
            role: target.role
          }))
        };
      }

      if (normalizedSql.startsWith('UPDATE users SET role')) {
        users[0].role = 'admin';
      }

      return { rowCount: 1, rows: [] };
    },
    release() {
      client.released = true;
    }
  };

  return {
    queries,
    client,
    pool: {
      async connect() {
        return client;
      }
    }
  };
}

test('explicit provisioning promotes a matching account and audits atomically', async () => {
  const fake = makeProvisionPool({ id: '44', role: 'user' });
  const result = await provisionAdministrator(fake.pool, {
    email: ' Owner@Example.test ',
    reason: 'Owner-confirmed administrator setup'
  });

  assert.deepEqual(result, { changed: true, userId: '44' });
  assert.equal(fake.client.released, true);

  const sql = fake.queries.map(query => query.sql);
  assert.ok(sql.indexOf(ADMIN_ROLE_LOCK_SQL) > sql.indexOf('BEGIN'));
  assert.ok(sql.indexOf('UPDATE users SET role = \'admin\' WHERE id = $1') <
    sql.indexOf('DELETE FROM sessions WHERE user_id = $1'));
  assert.ok(sql.indexOf('DELETE FROM sessions WHERE user_id = $1') <
    sql.findIndex(query => query.startsWith('INSERT INTO admin_provisioning_audit')));
  assert.equal(sql.at(-1), 'COMMIT');

  const sessionRevocation = fake.queries.find(query =>
    query.sql === 'DELETE FROM sessions WHERE user_id = $1'
  );
  assert.deepEqual(sessionRevocation.params, ['44']);

  const audit = fake.queries.find(query =>
    query.sql.startsWith('INSERT INTO admin_provisioning_audit')
  );
  assert.deepEqual(audit.params, [
    '44',
    `uid:${os.userInfo().uid};username:${os.userInfo().username}`,
    'Owner-confirmed administrator setup'
  ]);
});

test('provisioning rolls back role and session changes if audit insertion fails', async () => {
  const fake = makeProvisionPool(
    { id: '44', role: 'user' },
    { failOn: 'INSERT INTO admin_provisioning_audit' }
  );

  await assert.rejects(
    provisionAdministrator(fake.pool, {
      email: 'owner@example.test',
      reason: 'Owner-confirmed administrator setup'
    }),
    /Simulated database failure/
  );

  const sql = fake.queries.map(query => query.sql);
  const roleChangeIndex = sql.indexOf(
    'UPDATE users SET role = \'admin\' WHERE id = $1'
  );
  const sessionRevocationIndex = sql.indexOf(
    'DELETE FROM sessions WHERE user_id = $1'
  );
  const auditIndex = sql.findIndex(query =>
    query.startsWith('INSERT INTO admin_provisioning_audit')
  );

  assert.ok(roleChangeIndex > sql.indexOf('BEGIN'));
  assert.ok(sessionRevocationIndex > roleChangeIndex);
  assert.ok(auditIndex > sessionRevocationIndex);
  assert.equal(sql.at(-1), 'ROLLBACK');
  assert.equal(sql.includes('COMMIT'), false);
  assert.equal(fake.client.released, true);
});

test('provisioning audit identity comes from the operating system', async () => {
  const fake = makeProvisionPool({ id: '44', role: 'user' });
  await provisionAdministrator(fake.pool, {
    email: 'owner@example.test',
    operator: 'Unverified caller-supplied identity',
    reason: 'Owner-confirmed administrator setup'
  });

  const audit = fake.queries.find(query =>
    query.sql.startsWith('INSERT INTO admin_provisioning_audit')
  );
  assert.equal(
    audit.params[1],
    `uid:${os.userInfo().uid};username:${os.userInfo().username}`
  );
});

test('provisioning is idempotent and never demotes administrators', async () => {
  const fake = makeProvisionPool({ id: '44', role: 'admin' });
  const result = await provisionAdministrator(fake.pool, {
    email: 'owner@example.test',
    reason: 'Owner-confirmed administrator setup'
  });

  assert.deepEqual(result, { changed: false, userId: '44' });
  assert.equal(
    fake.queries.some(query => query.sql.startsWith('UPDATE users')),
    false
  );
  assert.equal(
    fake.queries.some(query =>
      query.sql.startsWith('INSERT INTO admin_provisioning_audit')
    ),
    false
  );
});

test('provisioning rolls back if the account is not found', async () => {
  const fake = makeProvisionPool(null);

  await assert.rejects(
    provisionAdministrator(fake.pool, {
      email: 'owner@example.test',
      reason: 'Owner-confirmed administrator setup'
    }),
    /No matching account/
  );

  assert.equal(fake.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(fake.client.released, true);
});

test('provisioning stops when multiple accounts match the email', async () => {
  const fake = makeProvisionPool([
    { id: '44', role: 'user' },
    { id: '45', role: 'user' }
  ]);

  await assert.rejects(
    provisionAdministrator(fake.pool, {
      email: 'owner@example.test',
      reason: 'Owner-confirmed administrator setup'
    }),
    /Multiple accounts match/
  );

  assert.equal(
    fake.queries.some(query => query.sql.startsWith('UPDATE users')),
    false
  );
  assert.equal(fake.queries.at(-1).sql, 'ROLLBACK');
});
