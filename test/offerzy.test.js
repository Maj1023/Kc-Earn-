'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  verifyOfferzySignature,
  parseOfferzyCallback,
  calculateOfferzyRewardKobo,
  handleOfferzyPostback
} = require('../server/offerzy');

const PRIVATE_KEY = 'local-test-private-key-only';

function makeParams(overrides = {}) {
  const data = {
    user_id: '42',
    status: '1',
    reward: '1500',
    payout: '1.50',
    transaction_id: 'local-test-607',
    offer_id: 'offer-test',
    ...overrides
  };

  data.signature = crypto
    .createHash('md5')
    .update(data.user_id + data.reward + data.offer_id + PRIVATE_KEY)
    .digest('hex');

  return new URLSearchParams(data);
}

test('accepts a valid Offerzy signature', () => {
  const parsed = parseOfferzyCallback(makeParams());
  assert.ok(parsed.data);
  assert.equal(verifyOfferzySignature(parsed.data, PRIVATE_KEY), true);
});

test('rejects a modified signature', () => {
  const parsed = parseOfferzyCallback(makeParams());
  parsed.data.signature = '00000000000000000000000000000000';
  assert.equal(verifyOfferzySignature(parsed.data, PRIVATE_KEY), false);
});

test('rejects a missing private key', () => {
  const parsed = parseOfferzyCallback(makeParams());
  assert.equal(verifyOfferzySignature(parsed.data, ''), false);
});

test('rejects missing required fields', () => {
  const params = makeParams();
  params.delete('offer_id');
  assert.match(parseOfferzyCallback(params).error, /Missing required/);
});

test('rejects duplicate parameters', () => {
  const params = makeParams();
  params.append('user_id', '43');
  assert.match(parseOfferzyCallback(params).error, /Duplicate/);
});

test('rejects unsupported status values', () => {
  assert.match(
    parseOfferzyCallback(makeParams({ status: '3' })).error,
    /Invalid callback status/
  );
});

test('rejects negative conversion amounts', () => {
  assert.match(
    parseOfferzyCallback(makeParams({ reward: '-1500' })).error,
    /positive/
  );
});

test('accepts correctly signed negative reversal amounts', () => {
  const parsed = parseOfferzyCallback(makeParams({
    status: '2',
    reward: '-1500',
    payout: '-1.50'
  }));

  assert.ok(parsed.data);
  assert.equal(verifyOfferzySignature(parsed.data, PRIVATE_KEY), true);
});

test('rejects malformed numeric values', () => {
  assert.match(
    parseOfferzyCallback(makeParams({ reward: '1e5' })).error,
    /Invalid reward/
  );
});


function makeFakePool(options = {}) {
  const queries = [];
  let connectCount = 0;

  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes('user_id::text')) {
        return options.original || { rowCount: 0, rows: [] };
      }

      if (sql.includes('FROM reward_settings')) {
        return options.settings || {
          rowCount: 1,
          rows: [{
            user_reward_percent: 80,
            usd_to_ngn_rate: '1500.0000',
            rewards_enabled: true
          }]
        };
      }

      if (sql.includes('SELECT id FROM offerzy_postbacks')) {
        return options.existing || { rowCount: 0, rows: [] };
      }

      if (sql.includes('SELECT outstanding_kobo::text')) {
        return {
          rowCount: 1,
          rows: [{ outstanding_kobo: options.debt || '0' }]
        };
      }

      if (sql.includes('SELECT balance_kobo::text')) {
        return {
          rowCount: 1,
          rows: [{ balance_kobo: options.balance || '0' }]
        };
      }

      if (sql.includes('SELECT total_recovered_kobo::text')) {
        return {
          rowCount: 1,
          rows: [{ total_recovered_kobo: options.totalRecovered || '0' }]
        };
      }

      if (sql.includes('reward_matches')) {
        return options.amounts || {
          rowCount: 1,
          rows: [{ reward_matches: true, payout_matches: true }]
        };
      }

      if (sql.includes('INSERT INTO offerzy_postbacks')) {
        return options.insert || { rowCount: 1, rows: [{ id: 1 }] };
      }

      return { rowCount: 0, rows: [] };
    },
    release() {
      queries.push({ sql: 'RELEASE', params: [] });
    }
  };

  return {
    pool: {
      async connect() {
        connectCount++;
        return client;
      }
    },
    queries,
    get connectCount() {
      return connectCount;
    }
  };
}

test('rejects missing Offerzy configuration without database access', async () => {
  const fake = makeFakePool();
  const result = await handleOfferzyPostback({
    params: makeParams(),
    pool: fake.pool,
    privateKey: ''
  });

  assert.equal(result.status, 503);
  assert.equal(fake.connectCount, 0);
});

test('rejects invalid signature without database access', async () => {
  const params = makeParams();
  params.set('signature', '00000000000000000000000000000000');

  const fake = makeFakePool();
  const result = await handleOfferzyPostback({
    params,
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 403);
  assert.equal(fake.connectCount, 0);
});

test('credits a valid conversion to the customer wallet', async () => {
  const fake = makeFakePool();
  const result = await handleOfferzyPostback({
    params: makeParams(),
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');
  assert.ok(fake.queries.some(q => q.sql.includes('INSERT INTO offerzy_postbacks')));
  assert.ok(fake.queries.some(q => q.sql.includes('UPDATE wallets')));
  assert.ok(fake.queries.some(q => q.sql.includes('INSERT INTO wallet_transactions')));
  assert.ok(fake.queries.some(q => q.sql === 'COMMIT'));
});

test('acknowledges repeated conversion as duplicate', async () => {
  const fake = makeFakePool({
    insert: { rowCount: 0, rows: [] }
  });

  const result = await handleOfferzyPostback({
    params: makeParams(),
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, 'duplicate');
});

test('records a matching reversal', async () => {
  const fake = makeFakePool({
    original: {
      rowCount: 1,
      rows: [{
        user_id: '42',
        offer_id: 'offer-test',
        reward_coins: '1500',
        payout_usd: '1.50000000',
        wallet_credit_kobo: '180000',
        recovery_applied_kobo: '0'
      }]
    },
    balance: '180000'
  });

  const result = await handleOfferzyPostback({
    params: makeParams({
      status: '2',
      reward: '-1500',
      payout: '-1.50'
    }),
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');
  assert.ok(fake.queries.some(q => q.sql === 'COMMIT'));
});

test('rejects a reversal when its original conversion is missing', async () => {
  const fake = makeFakePool();
  const result = await handleOfferzyPostback({
    params: makeParams({
      status: '2',
      reward: '-1500',
      payout: '-1.50'
    }),
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 409);
  assert.ok(fake.queries.some(q => q.sql === 'ROLLBACK'));
});


test('calculates Offerzy rewards using exact integer arithmetic', () => {
  assert.equal(
    calculateOfferzyRewardKobo('1.50', '1500.0000', 80),
    '180000'
  );
});

test('rounds calculated rewards to the nearest kobo', () => {
  assert.equal(
    calculateOfferzyRewardKobo('0.00000100', '5000.0000', 100),
    '1'
  );
});

test('returns zero when customer reward percentage is zero', () => {
  assert.equal(
    calculateOfferzyRewardKobo('1.50', '1500.0000', 0),
    '0'
  );
});

test('rejects invalid calculator inputs', () => {
  assert.throws(
    () => calculateOfferzyRewardKobo('-1.50', '1500.0000', 80)
  );
  assert.throws(
    () => calculateOfferzyRewardKobo('1.50', '1000000.0001', 80)
  );
  assert.throws(
    () => calculateOfferzyRewardKobo('1.50', '1500.0000', 101)
  );
});

test('rejects rewards exceeding the BIGINT wallet limit', () => {
  assert.throws(
    () => calculateOfferzyRewardKobo(
      '999999999999.99999999',
      '1000000.0000',
      100
    ),
    /wallet limit/
  );
});



test('creates debt when a reversal exceeds the remaining wallet balance', async () => {
  const fake = makeFakePool({
    original: {
      rowCount: 1,
      rows: [{
        user_id: '42',
        offer_id: 'offer-test',
        reward_coins: '1500',
        payout_usd: '1.50000000',
        wallet_credit_kobo: '180000',
        recovery_applied_kobo: '0'
      }]
    },
    balance: '50000',
    debt: '0'
  });

  const result = await handleOfferzyPostback({
    params: makeParams({
      status: '2',
      reward: '-1500',
      payout: '-1.50'
    }),
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');

  const walletDebit = fake.queries.find(q =>
    q.sql.includes('UPDATE wallets')
  );
  assert.ok(walletDebit);
  assert.equal(walletDebit.params[1], '50000');

  const debtUpdate = fake.queries.find(q =>
    q.sql.includes('UPDATE offerzy_recovery_accounts') &&
    q.sql.includes('outstanding_kobo = outstanding_kobo +')
  );
  assert.ok(debtUpdate);
  assert.equal(debtUpdate.params[1], '130000');

  const debtLedger = fake.queries.find(q =>
    q.sql.includes("'debt_added'")
  );
  assert.ok(debtLedger);
  assert.equal(debtLedger.params[3], '130000');

  const accounting = fake.queries.find(q =>
    q.sql.includes('recovery_added_kobo')
  );
  assert.ok(accounting);
  assert.deepEqual(accounting.params.slice(1), [
    '50000', '130000', '0'
  ]);

  assert.ok(fake.queries.some(q => q.sql === 'COMMIT'));
});

test('uses future verified earnings to repay debt before wallet credit', async () => {
  const fake = makeFakePool({
    debt: '120000',
    balance: '10000',
    totalRecovered: '0'
  });

  const result = await handleOfferzyPostback({
    params: makeParams(),
    pool: fake.pool,
    privateKey: PRIVATE_KEY
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');

  const walletCredit = fake.queries.find(q =>
    q.sql.includes('UPDATE wallets')
  );
  assert.ok(walletCredit);
  assert.equal(walletCredit.params[1], '60000');

  const recoveryUpdate = fake.queries.find(q =>
    q.sql.includes('UPDATE offerzy_recovery_accounts') &&
    q.sql.includes('total_recovered_kobo = total_recovered_kobo +')
  );
  assert.ok(recoveryUpdate);
  assert.deepEqual(recoveryUpdate.params, [
    '42', '0', '120000'
  ]);

  const debtLedger = fake.queries.find(q =>
    q.sql.includes("'debt_repaid'")
  );
  assert.ok(debtLedger);
  assert.equal(debtLedger.params[3], '120000');

  const accounting = fake.queries.find(q =>
    q.sql.includes('SET wallet_credit_kobo')
  );
  assert.ok(accounting);
  assert.deepEqual(accounting.params, [
    1, '60000', '120000'
  ]);

  assert.ok(fake.queries.some(q => q.sql === 'COMMIT'));
});
