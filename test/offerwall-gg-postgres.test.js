'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const {
  createOfferwallGGTables,
  handleOfferwallGGPostback
} = require('../server/offerwall-gg');

const secretKey = crypto.randomBytes(32).toString('hex');
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  test('Offerwall.GG PostgreSQL integration requires TEST_DATABASE_URL', {
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

  const schema =
    `kc_earn_offerwall_gg_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const setupPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 5,
    options: `-c search_path=${schema}`
  });
  let schemaCreated = false;
  let userId;

  test.before(async () => {
    await setupPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    await pool.query(`
      CREATE TABLE users (
        id BIGSERIAL PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE wallets (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance_kobo BIGINT NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE wallet_transactions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        transaction_type VARCHAR(10) NOT NULL
          CHECK (transaction_type IN ('credit', 'debit')),
        amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
        description VARCHAR(255) NOT NULL,
        reference VARCHAR(100) UNIQUE
      )
    `);
    await pool.query(`
      CREATE TABLE reward_settings (
        id SMALLINT PRIMARY KEY,
        user_reward_percent SMALLINT NOT NULL,
        usd_to_ngn_rate NUMERIC(20,4) NOT NULL,
        rewards_enabled BOOLEAN NOT NULL
      )
    `);
    await createOfferwallGGTables(pool);

    const user = await pool.query(
      `INSERT INTO users (full_name, email)
       VALUES ('Offerwall Test User', 'offerwall-test@example.test')
       RETURNING id`
    );
    userId = user.rows[0].id;
    await pool.query(
      'INSERT INTO wallets (user_id) VALUES ($1)',
      [userId]
    );
  });

  test.beforeEach(async () => {
    await pool.query('DELETE FROM offerwall_gg_recovery_ledger');
    await pool.query('DELETE FROM offerwall_gg_postbacks');
    await pool.query('DELETE FROM offerwall_gg_recovery_accounts');
    await pool.query('DELETE FROM wallet_transactions');
    await pool.query(
      'UPDATE wallets SET balance_kobo = 0 WHERE user_id = $1',
      [userId]
    );
    await pool.query(
      `INSERT INTO reward_settings
       (id, user_reward_percent, usd_to_ngn_rate, rewards_enabled)
       VALUES (1, 80, 1500.0000, TRUE)
       ON CONFLICT (id) DO UPDATE SET
         user_reward_percent = EXCLUDED.user_reward_percent,
         usd_to_ngn_rate = EXCLUDED.usd_to_ngn_rate,
         rewards_enabled = EXCLUDED.rewards_enabled`
    );
  });

  test.after(async () => {
    await pool.end();

    if (schemaCreated) {
      await setupPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }

    await setupPool.end();
  });

  function makeCallback({
    transactionId,
    currencyAmount,
    status = 'credited',
    testFlag = '0'
  }) {
    const values = {
      userId: String(userId),
      transactionId,
      currencyAmount,
      currencyName: 'Points',
      offerId: 'pg-test-offer',
      offerName: 'PostgreSQL test offer',
      goalId: '',
      payoutUsd: '0.250000',
      status,
      test: testFlag,
      timestamp: '1760000000'
    };
    values.signature = crypto
      .createHmac('sha256', secretKey)
      .update(
        `${values.userId}:${values.transactionId}:${values.currencyAmount}`,
        'utf8'
      )
      .digest('hex');
    return new URLSearchParams(values).toString();
  }

  async function sendCallback(parameters) {
    return handleOfferwallGGPostback({
      rawParameters: parameters,
      pool,
      secretKey,
      unitsPerUsd: '1000'
    });
  }

  async function readWallet() {
    const result = await pool.query(
      'SELECT balance_kobo::text AS balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    return result.rows[0].balance;
  }

  test('credits a verified conversion once and ignores signed test callbacks', async () => {
    const testResult = await sendCallback(makeCallback({
      transactionId: 'owgg-test-postback',
      currencyAmount: '250.0000',
      testFlag: '1'
    }));
    assert.equal(testResult.status, 200);
    assert.equal(await readWallet(), '0');

    const parameters = makeCallback({
      transactionId: 'owgg-credit-once',
      currencyAmount: '250.0000'
    });
    const result = await sendCallback(parameters);
    assert.equal(result.status, 200);
    assert.equal(await readWallet(), '30000');

    const duplicate = await sendCallback(parameters);
    assert.equal(duplicate.status, 200);
    assert.equal(await readWallet(), '30000');

    const counts = await pool.query(
      `SELECT COUNT(*)::int AS postbacks,
              (SELECT COUNT(*)::int FROM wallet_transactions) AS ledger_rows
       FROM offerwall_gg_postbacks`
    );
    assert.deepEqual(counts.rows[0], { postbacks: 1, ledger_rows: 1 });
  });

  test('does not credit conversions while admin rewards are disabled', async () => {
    await pool.query(
      'UPDATE reward_settings SET rewards_enabled = FALSE WHERE id = 1'
    );

    const result = await sendCallback(makeCallback({
      transactionId: 'owgg-disabled-rewards',
      currencyAmount: '250.0000'
    }));

    assert.equal(result.status, 503);
    assert.equal(await readWallet(), '0');
    const postbacks = await pool.query(
      `SELECT COUNT(*)::int AS count FROM offerwall_gg_postbacks
       WHERE transaction_id = 'owgg-disabled-rewards'`
    );
    assert.equal(postbacks.rows[0].count, 0);
  });

  test('reversal debits its recorded credit once', async () => {
    await sendCallback(makeCallback({
      transactionId: 'owgg-reversal',
      currencyAmount: '250.0000'
    }));
    assert.equal(await readWallet(), '30000');

    const reversal = makeCallback({
      transactionId: 'owgg-reversal',
      currencyAmount: '-250.0000',
      status: 'reversed'
    });
    assert.equal((await sendCallback(reversal)).status, 200);
    assert.equal(await readWallet(), '0');
    assert.equal((await sendCallback(reversal)).status, 200);
    assert.equal(await readWallet(), '0');
  });

  test('concurrent retries of one transaction create only one wallet credit', async () => {
    const parameters = makeCallback({
      transactionId: 'owgg-concurrent-duplicate',
      currencyAmount: '250.0000'
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => sendCallback(parameters))
    );
    assert.ok(results.every(result => result.status === 200));

    const postbacks = await pool.query(
      `SELECT COUNT(*)::int AS count FROM offerwall_gg_postbacks
       WHERE transaction_id = 'owgg-concurrent-duplicate'
         AND status = 'credited'`
    );
    assert.equal(postbacks.rows[0].count, 1);
    assert.equal(await readWallet(), '30000');
  });

  test('unavailable funds become tracked debt and future provider credits repay it', async () => {
    await sendCallback(makeCallback({
      transactionId: 'owgg-debt',
      currencyAmount: '250.0000'
    }));
    await pool.query(
      'UPDATE wallets SET balance_kobo = 10000 WHERE user_id = $1',
      [userId]
    );

    assert.equal((await sendCallback(makeCallback({
      transactionId: 'owgg-debt',
      currencyAmount: '-250.0000',
      status: 'reversed'
    }))).status, 200);
    assert.equal(await readWallet(), '0');

    const debt = await pool.query(
      `SELECT outstanding_kobo::text AS outstanding
       FROM offerwall_gg_recovery_accounts WHERE user_id = $1`,
      [userId]
    );
    assert.equal(debt.rows[0].outstanding, '20000');

    await sendCallback(makeCallback({
      transactionId: 'owgg-repay-debt',
      currencyAmount: '250.0000'
    }));
    assert.equal(await readWallet(), '10000');

    const accounting = await pool.query(
      `SELECT outstanding_kobo::text AS outstanding,
              total_recovered_kobo::text AS recovered
       FROM offerwall_gg_recovery_accounts WHERE user_id = $1`,
      [userId]
    );
    assert.deepEqual(accounting.rows[0], {
      outstanding: '0',
      recovered: '20000'
    });
  });

  test('reversing a debt-repaying conversion restores the recovered debt', async () => {
    await pool.query(
      'UPDATE wallets SET balance_kobo = 10000 WHERE user_id = $1',
      [userId]
    );
    await pool.query(
      `INSERT INTO offerwall_gg_recovery_accounts
       (user_id, outstanding_kobo) VALUES ($1, 20000)`,
      [userId]
    );

    await sendCallback(makeCallback({
      transactionId: 'owgg-debt-restoration',
      currencyAmount: '250.0000'
    }));
    assert.equal(await readWallet(), '20000');

    assert.equal((await sendCallback(makeCallback({
      transactionId: 'owgg-debt-restoration',
      currencyAmount: '-250.0000',
      status: 'reversed'
    }))).status, 200);
    assert.equal(await readWallet(), '10000');

    const account = await pool.query(
      `SELECT outstanding_kobo::text AS outstanding,
              total_recovered_kobo::text AS recovered
       FROM offerwall_gg_recovery_accounts WHERE user_id = $1`,
      [userId]
    );
    assert.deepEqual(account.rows[0], {
      outstanding: '20000',
      recovered: '0'
    });
  });

  test('database failure rolls back the postback and wallet credit', async () => {
    await pool.query(`
      CREATE FUNCTION reject_offerwall_credit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.description = 'Verified Offerwall.GG reward' THEN
          RAISE EXCEPTION 'test wallet ledger failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER reject_offerwall_credit
      BEFORE INSERT ON wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION reject_offerwall_credit()
    `);

    try {
      await assert.rejects(
        sendCallback(makeCallback({
          transactionId: 'owgg-rollback',
          currencyAmount: '250.0000'
        })),
        /test wallet ledger failure/
      );
    } finally {
      await pool.query('DROP TRIGGER reject_offerwall_credit ON wallet_transactions');
      await pool.query('DROP FUNCTION reject_offerwall_credit()');
    }

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM offerwall_gg_postbacks
       WHERE transaction_id = 'owgg-rollback'`
    );
    assert.equal(result.rows[0].count, 0);
    assert.equal(await readWallet(), '0');
    const ledger = await pool.query(
      `SELECT COUNT(*)::int AS count FROM wallet_transactions`
    );
    assert.equal(ledger.rows[0].count, 0);
  });
}
