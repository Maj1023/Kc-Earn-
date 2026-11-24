'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const {
  createSessionRecord,
  provisionAdministrator
} = require('../server/admin-security');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  test('PostgreSQL admin/session integration requires TEST_DATABASE_URL', {
    skip: 'No dedicated PostgreSQL test database is configured.'
  }, () => {});
} else {
  const databaseUrl = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));

  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must point to a database with "test" in its name.'
    );
  }

  const schema = `kc_earn_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const applicationName = 'kc-earn-admin-security-test';
  const setupPool = new Pool({
    connectionString: testDatabaseUrl,
    max: 1
  });
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 5,
    application_name: applicationName
  });

  pool.on('connect', (client) => {
    client.searchPathReady = client.query(
      `SET search_path TO "${schema}"`
    );
  });

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args) => {
    if (typeof args[0] === 'function') {
      const callback = args[0];
      return originalConnect((error, client, release) => {
        if (error) return callback(error);
        Promise.resolve(client.searchPathReady).then(
          () => callback(null, client, release),
          setupError => {
            release(setupError);
            callback(setupError);
          }
        );
      });
    }

    return originalConnect().then(async client => {
      try {
        await client.searchPathReady;
        return client;
      } catch (error) {
        client.release(error);
        throw error;
      }
    });
  };

  let schemaCreated = false;

  test.before(async () => {
    await setupPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    await pool.query(`
      CREATE TABLE users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        role VARCHAR(20) NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE admin_provisioning_audit (
        id BIGSERIAL PRIMARY KEY,
        target_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        operator_label VARCHAR(100) NOT NULL,
        old_role VARCHAR(20) NOT NULL,
        new_role VARCHAR(20) NOT NULL,
        reason VARCHAR(255) NOT NULL
          CHECK (reason <> 'force audit failure')
      )
    `);
  });

  test.after(async () => {
    await pool.end();

    if (schemaCreated) {
      await setupPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }

    await setupPool.end();
  });

  async function insertUser(role = 'user') {
    const email = `${crypto.randomBytes(8).toString('hex')}@example.test`;
    const result = await pool.query(
      'INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id, email, role',
      [email, role]
    );
    return result.rows[0];
  }

  async function countRows(table, userId) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${
        table === 'sessions' ? 'user_id' : 'target_user_id'
      } = $1`,
      [userId]
    );
    return result.rows[0].count;
  }

  async function waitForActivity(matches, description) {
    const deadline = Date.now() + 5000;
    let observedRows = [];

    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT pid, application_name, state, query, wait_event_type
         FROM pg_stat_activity
         WHERE application_name = $1
           AND pid <> pg_backend_pid()`,
        [applicationName]
      );

      observedRows = result.rows;

      if (result.rows.some(matches)) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.fail(
      `Timed out waiting for ${description}. Observed activity: ${JSON.stringify(observedRows)}`
    );
  }

  test('promotion atomically revokes existing sessions and records its audit', async () => {
    const user = await insertUser();
    const tokens = [
      crypto.randomBytes(32).toString('hex'),
      crypto.randomBytes(32).toString('hex')
    ];

    for (const token of tokens) {
      await pool.query(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, user.id, new Date(Date.now() + 60_000)]
      );
    }

    const result = await provisionAdministrator(pool, {
      email: user.email,
      reason: 'Dedicated PostgreSQL integration test'
    });

    assert.deepEqual(result, { changed: true, userId: user.id });
    const updatedUser = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [user.id]
    );
    assert.equal(updatedUser.rows[0].role, 'admin');
    assert.equal(await countRows('sessions', user.id), 0);
    assert.equal(await countRows('admin_provisioning_audit', user.id), 1);
  });

  test('audit failure rolls back promotion and session deletion', async () => {
    const user = await insertUser();
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, user.id, new Date(Date.now() + 60_000)]
    );

    await assert.rejects(
      provisionAdministrator(pool, {
        email: user.email,
        reason: 'force audit failure'
      }),
      /violates check constraint/
    );

    const updatedUser = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [user.id]
    );
    assert.equal(updatedUser.rows[0].role, 'user');
    assert.equal(await countRows('sessions', user.id), 1);
    assert.equal(await countRows('admin_provisioning_audit', user.id), 0);
  });

  test('concurrent login session creation serializes with promotion', async () => {
    const user = await insertUser();
    await pool.query(`
      CREATE FUNCTION pause_session_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.75);
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER pause_session_insert
      BEFORE INSERT ON sessions
      FOR EACH ROW EXECUTE FUNCTION pause_session_insert()
    `);

    try {
      const login = createSessionRecord(pool, {
        userId: user.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000)
      });

      await waitForActivity(
        row => row.query.toLowerCase().includes('insert into sessions'),
        'the login session insert'
      );

      const promotion = provisionAdministrator(pool, {
        email: user.email,
        reason: 'Concurrent PostgreSQL integration test'
      });

      await waitForActivity(
        row => row.wait_event_type === 'Lock' &&
          row.query.toLowerCase().includes('select id, role from users'),
        'promotion to wait on the login account lock'
      );

      await Promise.all([login, promotion]);
    } finally {
      await pool.query('DROP TRIGGER pause_session_insert ON sessions');
      await pool.query('DROP FUNCTION pause_session_insert()');
    }

    const updatedUser = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [user.id]
    );
    assert.equal(updatedUser.rows[0].role, 'admin');
    assert.equal(await countRows('sessions', user.id), 0);
    assert.equal(await countRows('admin_provisioning_audit', user.id), 1);

    await createSessionRecord(pool, {
      userId: user.id,
      tokenHash: crypto.randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 60_000)
    });
    assert.equal(await countRows('sessions', user.id), 1);
  });
}
