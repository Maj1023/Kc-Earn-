'use strict';

const crypto = require('node:crypto');

const MAX_BIGINT = 9223372036854775807n;
const AMOUNT_PATTERN = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/;
const RATE_PATTERN = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,4})?$/;
const UNITS_PATTERN = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/;
const ALLOWED_FIELDS = new Set([
  'userId',
  'transactionId',
  'offerId',
  'offerName',
  'goalId',
  'currencyAmount',
  'currencyName',
  'payoutUsd',
  'status',
  'test',
  'timestamp',
  'signature'
]);

function decodeQueryComponent(value) {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

function parseCallbackParameters(rawParameters) {
  if (typeof rawParameters !== 'string' || rawParameters.length === 0) {
    return { error: 'Missing Offerwall.GG callback parameters.' };
  }

  const values = Object.create(null);

  for (const pair of rawParameters.split('&')) {
    const separator = pair.indexOf('=');

    if (separator <= 0) {
      return { error: 'Malformed Offerwall.GG callback parameter.' };
    }

    let key;
    let value;

    try {
      key = decodeQueryComponent(pair.slice(0, separator));
      value = decodeQueryComponent(pair.slice(separator + 1));
    } catch {
      return { error: 'Malformed Offerwall.GG callback encoding.' };
    }

    if (!key || Object.prototype.hasOwnProperty.call(values, key)) {
      return { error: 'Duplicate or empty Offerwall.GG callback parameter.' };
    }

    if (!ALLOWED_FIELDS.has(key)) {
      return { error: 'Unexpected Offerwall.GG callback parameter.' };
    }

    values[key] = value;
  }

  for (const field of [
    'userId',
    'transactionId',
    'currencyAmount',
    'status',
    'test',
    'signature'
  ]) {
    if (typeof values[field] !== 'string' || values[field].length === 0) {
      return { error: 'Missing Offerwall.GG callback parameter: ' + field };
    }
  }

  return { values };
}

function verifyOfferwallGGSignature({ userId, transactionId, currencyAmount, signature }, secretKey) {
  if (typeof secretKey !== 'string' || secretKey.length === 0 ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secretKey)
    .update(`${userId}:${transactionId}:${currencyAmount}`, 'utf8')
    .digest();
  const supplied = Buffer.from(signature, 'hex');

  return supplied.length === expected.length &&
    crypto.timingSafeEqual(expected, supplied);
}

function parseScaledDecimal(value, pattern, scale) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return null;
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const scaled = BigInt(whole + fraction.padEnd(scale, '0'));

  if (scaled === 0n) {
    return null;
  }

  return negative ? -scaled : scaled;
}

function parseOfferwallGGCallback(rawParameters, secretKey) {
  const parsed = parseCallbackParameters(rawParameters);

  if (parsed.error) {
    return parsed;
  }

  const values = parsed.values;

  if (!verifyOfferwallGGSignature({
    userId: values.userId,
    transactionId: values.transactionId,
    currencyAmount: values.currencyAmount,
    signature: values.signature
  }, secretKey)) {
    return { error: 'Invalid Offerwall.GG signature.' };
  }

  if (values.test !== '1' &&
      (!/^[1-9]\d{0,18}$/.test(values.userId) ||
       BigInt(values.userId) > MAX_BIGINT)) {
    return { error: 'Invalid Offerwall.GG userId.' };
  }

  if (values.transactionId.length > 150) {
    return { error: 'Offerwall.GG transactionId is too long.' };
  }

  const amountScaled = parseScaledDecimal(
    values.currencyAmount,
    AMOUNT_PATTERN,
    4
  );

  if (amountScaled === null) {
    return { error: 'Invalid Offerwall.GG currencyAmount.' };
  }

  if (values.status !== 'credited' && values.status !== 'reversed') {
    return { error: 'Invalid Offerwall.GG status.' };
  }

  if (values.test !== '0' && values.test !== '1') {
    return { error: 'Invalid Offerwall.GG test flag.' };
  }

  if ((values.status === 'credited' && amountScaled < 0n) ||
      (values.status === 'reversed' && amountScaled > 0n)) {
    return { error: 'Offerwall.GG status and currencyAmount sign do not match.' };
  }

  if (values.offerId?.length > 150 ||
      values.offerName?.length > 255 ||
      values.goalId?.length > 100 ||
      values.currencyName?.length > 64 ||
      values.timestamp && !/^\d{1,12}$/.test(values.timestamp)) {
    return { error: 'Offerwall.GG callback metadata is invalid.' };
  }

  return {
    data: {
      userId: values.userId,
      transactionId: values.transactionId,
      currencyAmount: values.currencyAmount,
      currencyAmountScaled: amountScaled,
      status: values.status,
      test: values.test,
      offerId: values.offerId || null,
      offerName: values.offerName || null,
      goalId: values.goalId || null,
      currencyName: values.currencyName || null
    }
  };
}

function parseUnitsPerUsd(value) {
  const scaled = parseScaledDecimal(value, UNITS_PATTERN, 12);

  if (scaled === null || scaled < 0n) {
    throw new Error('OFFERWALL_GG_UNITS_PER_USD must be a positive decimal.');
  }

  return scaled;
}

function parseExchangeRate(value) {
  if (typeof value !== 'string' || !RATE_PATTERN.test(value)) {
    throw new Error('Invalid configured USD-to-NGN exchange rate.');
  }

  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(4, '0'));
}

function calculateOfferwallGGRewardKobo(
  currencyAmount,
  unitsPerUsd,
  exchangeRate,
  rewardPercent
) {
  const amountScaled = parseScaledDecimal(
    currencyAmount,
    AMOUNT_PATTERN,
    4
  );
  const unitsScaled = parseUnitsPerUsd(unitsPerUsd);
  const rateScaled = parseExchangeRate(exchangeRate);

  if (amountScaled === null || amountScaled < 0n) {
    throw new Error('A positive Offerwall.GG currencyAmount is required.');
  }

  if (!Number.isInteger(rewardPercent) ||
      rewardPercent < 0 || rewardPercent > 100) {
    throw new Error('Invalid configured customer reward percentage.');
  }

  // currencyAmount is units-per-USD multiplied by publisher USD payout.
  // The result is floored to whole kobo; reversal uses the recorded credit.
  const rewardKobo =
    (amountScaled * rateScaled * BigInt(rewardPercent) * 10000n) /
    unitsScaled;

  if (rewardKobo > MAX_BIGINT) {
    throw new Error('Calculated Offerwall.GG reward exceeds the wallet limit.');
  }

  return rewardKobo;
}

function buildOfferwallGGWallUrl({
  publicKey,
  secretKey,
  unitsPerUsd,
  userId,
  timestampedLinks = false,
  now = Date.now()
}) {
  if (typeof publicKey !== 'string' || !/^[a-f0-9]{32}$/i.test(publicKey) ||
      typeof secretKey !== 'string' || secretKey.length === 0) {
    throw new Error('Offerwall.GG access is not configured.');
  }

  parseUnitsPerUsd(unitsPerUsd);

  const normalizedUserId = String(userId);

  if (!/^[1-9]\d{0,18}$/.test(normalizedUserId) ||
      BigInt(normalizedUserId) > MAX_BIGINT) {
    throw new Error('A valid KC Earn user ID is required.');
  }

  const signedParameters = {
    appId: publicKey,
    userId: normalizedUserId
  };

  if (timestampedLinks) {
    signedParameters.ts = String(Math.floor(now / 1000));
  }

  const canonical = Object.entries(signedParameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(canonical, 'utf8')
    .digest('hex');

  const query = new URLSearchParams(signedParameters);
  query.set('signature', signature);

  return `https://offerwall.gg/wall/${encodeURIComponent(publicKey)}?${query}`;
}

async function createOfferwallGGTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offerwall_gg_postbacks (
      id BIGSERIAL PRIMARY KEY,
      transaction_id VARCHAR(150) NOT NULL,
      status VARCHAR(10) NOT NULL CHECK (status IN ('credited', 'reversed')),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      currency_amount NUMERIC(20,4) NOT NULL,
      currency_name VARCHAR(64),
      offer_id VARCHAR(150),
      offer_name VARCHAR(255),
      goal_id VARCHAR(100),
      units_per_usd NUMERIC(30,12),
      usd_to_ngn_rate NUMERIC(20,4),
      user_reward_percent SMALLINT
        CHECK (user_reward_percent BETWEEN 0 AND 100),
      calculated_reward_kobo BIGINT
        CHECK (calculated_reward_kobo >= 0),
      wallet_credit_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (wallet_credit_kobo >= 0),
      recovery_applied_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_applied_kobo >= 0),
      wallet_debit_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (wallet_debit_kobo >= 0),
      recovery_added_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_added_kobo >= 0),
      recovery_restored_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_restored_kobo >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT offerwall_gg_postbacks_transaction_status_unique
        UNIQUE (transaction_id, status)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS offerwall_gg_postbacks_user_created_idx
    ON offerwall_gg_postbacks(user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS offerwall_gg_recovery_accounts (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      outstanding_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (outstanding_kobo >= 0),
      total_recovered_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (total_recovered_kobo >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS offerwall_gg_recovery_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      postback_id BIGINT NOT NULL REFERENCES offerwall_gg_postbacks(id)
        ON DELETE RESTRICT,
      reference VARCHAR(100) NOT NULL UNIQUE,
      event_type VARCHAR(20) NOT NULL
        CHECK (event_type IN ('debt_added', 'debt_repaid', 'debt_restored')),
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function insertRecoveryLedger(client, {
  userId,
  postbackId,
  reference,
  eventType,
  amountKobo
}) {
  if (amountKobo === 0n) {
    return;
  }

  await client.query(
    `INSERT INTO offerwall_gg_recovery_ledger
     (user_id, postback_id, reference, event_type, amount_kobo)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, postbackId, reference, eventType, amountKobo.toString()]
  );
}

async function handleOfferwallGGPostback({
  rawParameters,
  pool,
  secretKey,
  unitsPerUsd
}) {
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    return { status: 503, body: 'Offerwall.GG callback is not configured.' };
  }

  const parsed = parseOfferwallGGCallback(rawParameters, secretKey);
  if (parsed.error) {
    const invalidSignature = parsed.error === 'Invalid Offerwall.GG signature.';
    return {
      status: invalidSignature ? 403 : 400,
      body: parsed.error
    };
  }

  const data = parsed.data;

  if (data.test === '1') {
    return { status: 200, body: 'OK' };
  }

  let unitsScaled;
  try {
    unitsScaled = parseUnitsPerUsd(unitsPerUsd);
  } catch {
    return {
      status: 503,
      body: 'Offerwall.GG currency units are not configured.'
    };
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    if (data.status === 'reversed') {
      const originalResult = await client.query(
        `SELECT id, user_id::text, currency_amount::text,
                wallet_credit_kobo::text, recovery_applied_kobo::text
         FROM offerwall_gg_postbacks
         WHERE transaction_id = $1 AND status = 'credited'
         FOR UPDATE`,
        [data.transactionId]
      );

      if (!originalResult.rowCount) {
        await client.query('ROLLBACK');
        return {
          status: 409,
          body: 'Original Offerwall.GG conversion not found; retry required.'
        };
      }

      const original = originalResult.rows[0];
      if (original.user_id !== data.userId ||
          parseScaledDecimal(original.currency_amount, AMOUNT_PATTERN, 4) !==
            -data.currencyAmountScaled) {
        await client.query('ROLLBACK');
        return {
          status: 409,
          body: 'Offerwall.GG reversal does not match its conversion.'
        };
      }

      const inserted = await client.query(
        `INSERT INTO offerwall_gg_postbacks (
           transaction_id, status, user_id, currency_amount,
           currency_name, offer_id, offer_name, goal_id
         ) VALUES ($1, 'reversed', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (transaction_id, status) DO NOTHING
         RETURNING id`,
        [
          data.transactionId,
          data.userId,
          data.currencyAmount,
          data.currencyName,
          data.offerId,
          data.offerName,
          data.goalId
        ]
      );

      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return { status: 200, body: 'OK' };
      }

      const reversalId = inserted.rows[0].id;
      const originalWalletCredit = BigInt(original.wallet_credit_kobo);
      const recoveryRestored = BigInt(original.recovery_applied_kobo);

      await client.query(
        `INSERT INTO offerwall_gg_recovery_accounts (user_id)
         VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [data.userId]
      );
      await client.query(
        `INSERT INTO wallets (user_id)
         VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [data.userId]
      );

      const recoveryResult = await client.query(
        `SELECT outstanding_kobo::text, total_recovered_kobo::text
         FROM offerwall_gg_recovery_accounts
         WHERE user_id = $1 FOR UPDATE`,
        [data.userId]
      );
      const walletResult = await client.query(
        `SELECT balance_kobo::text FROM wallets
         WHERE user_id = $1 FOR UPDATE`,
        [data.userId]
      );

      const currentBalance = BigInt(walletResult.rows[0].balance_kobo);
      const currentDebt = BigInt(recoveryResult.rows[0].outstanding_kobo);
      const totalRecovered = BigInt(recoveryResult.rows[0].total_recovered_kobo);
      if (totalRecovered < recoveryRestored) {
        throw new Error('Offerwall.GG recovery history is inconsistent.');
      }

      const walletDebit = currentBalance < originalWalletCredit
        ? currentBalance
        : originalWalletCredit;
      const debtShortfall = originalWalletCredit - walletDebit;
      const updatedDebt = currentDebt + debtShortfall + recoveryRestored;
      const updatedTotalRecovered = totalRecovered - recoveryRestored;

      if (updatedDebt > MAX_BIGINT) {
        throw new Error('Offerwall.GG recovery debt exceeds the database limit.');
      }

      if (walletDebit > 0n) {
        await client.query(
          `UPDATE wallets SET balance_kobo = balance_kobo - $2::bigint,
             updated_at = NOW() WHERE user_id = $1`,
          [data.userId, walletDebit.toString()]
        );
        await client.query(
          `INSERT INTO wallet_transactions
           (user_id, transaction_type, amount_kobo, description, reference)
           VALUES ($1, 'debit', $2, $3, $4)`,
          [
            data.userId,
            walletDebit.toString(),
            'Offerwall.GG reward reversal',
            'OWGG-REV-' + reversalId
          ]
        );
      }

      if (debtShortfall + recoveryRestored > 0n) {
        await client.query(
          `UPDATE offerwall_gg_recovery_accounts
           SET outstanding_kobo = $2, total_recovered_kobo = $3,
               updated_at = NOW()
           WHERE user_id = $1`,
          [
            data.userId,
            updatedDebt.toString(),
            updatedTotalRecovered.toString()
          ]
        );
      }

      await insertRecoveryLedger(client, {
        userId: data.userId,
        postbackId: reversalId,
        reference: 'OWGG-DEBT-ADD-' + reversalId,
        eventType: 'debt_added',
        amountKobo: debtShortfall
      });
      await insertRecoveryLedger(client, {
        userId: data.userId,
        postbackId: reversalId,
        reference: 'OWGG-DEBT-RESTORE-' + reversalId,
        eventType: 'debt_restored',
        amountKobo: recoveryRestored
      });
      await client.query(
        `UPDATE offerwall_gg_postbacks
         SET wallet_debit_kobo = $2, recovery_added_kobo = $3,
             recovery_restored_kobo = $4
         WHERE id = $1`,
        [
          reversalId,
          walletDebit.toString(),
          debtShortfall.toString(),
          recoveryRestored.toString()
        ]
      );

      await client.query('COMMIT');
      return { status: 200, body: 'OK' };
    }

    const existing = await client.query(
      `SELECT id FROM offerwall_gg_postbacks
       WHERE transaction_id = $1 AND status = 'credited'`,
      [data.transactionId]
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return { status: 200, body: 'OK' };
    }

    const settingsResult = await client.query(
      `SELECT user_reward_percent, usd_to_ngn_rate::text AS usd_to_ngn_rate,
              rewards_enabled
       FROM reward_settings WHERE id = 1 FOR SHARE`
    );
    if (settingsResult.rowCount !== 1) {
      throw new Error('Reward settings are not initialized.');
    }

    const settings = settingsResult.rows[0];
    if (settings.rewards_enabled !== true) {
      await client.query('ROLLBACK');
      return {
        status: 503,
        body: 'Offerwall.GG rewards are temporarily disabled.'
      };
    }

    const rewardPercent = Number(settings.user_reward_percent);
    const rewardKobo = calculateOfferwallGGRewardKobo(
      data.currencyAmount,
      unitsPerUsd,
      settings.usd_to_ngn_rate,
      rewardPercent
    );

    const inserted = await client.query(
      `INSERT INTO offerwall_gg_postbacks (
         transaction_id, status, user_id, currency_amount, currency_name,
         offer_id, offer_name, goal_id, units_per_usd, usd_to_ngn_rate,
         user_reward_percent, calculated_reward_kobo
       ) VALUES ($1, 'credited', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (transaction_id, status) DO NOTHING
       RETURNING id`,
      [
        data.transactionId,
        data.userId,
        data.currencyAmount,
        data.currencyName,
        data.offerId,
        data.offerName,
        data.goalId,
        unitsPerUsd,
        settings.usd_to_ngn_rate,
        rewardPercent,
        rewardKobo.toString()
      ]
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { status: 200, body: 'OK' };
    }

    const conversionId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO offerwall_gg_recovery_accounts (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [data.userId]
    );
    await client.query(
      `INSERT INTO wallets (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [data.userId]
    );

    const recoveryResult = await client.query(
      `SELECT outstanding_kobo::text, total_recovered_kobo::text
       FROM offerwall_gg_recovery_accounts
       WHERE user_id = $1 FOR UPDATE`,
      [data.userId]
    );
    const walletResult = await client.query(
      `SELECT balance_kobo::text FROM wallets
       WHERE user_id = $1 FOR UPDATE`,
      [data.userId]
    );

    const outstandingDebt = BigInt(recoveryResult.rows[0].outstanding_kobo);
    const totalRecovered = BigInt(recoveryResult.rows[0].total_recovered_kobo);
    const recoveryApplied = rewardKobo < outstandingDebt
      ? rewardKobo
      : outstandingDebt;
    const walletCredit = rewardKobo - recoveryApplied;
    const newBalance = BigInt(walletResult.rows[0].balance_kobo) + walletCredit;

    if (newBalance > MAX_BIGINT ||
        totalRecovered + recoveryApplied > MAX_BIGINT) {
      throw new Error('Offerwall.GG wallet accounting exceeds the database limit.');
    }

    if (walletCredit > 0n) {
      await client.query(
        `UPDATE wallets SET balance_kobo = balance_kobo + $2::bigint,
           updated_at = NOW() WHERE user_id = $1`,
        [data.userId, walletCredit.toString()]
      );
      await client.query(
        `INSERT INTO wallet_transactions
         (user_id, transaction_type, amount_kobo, description, reference)
         VALUES ($1, 'credit', $2, $3, $4)`,
        [
          data.userId,
          walletCredit.toString(),
          'Verified Offerwall.GG reward',
          'OWGG-CREDIT-' + conversionId
        ]
      );
    }

    if (recoveryApplied > 0n) {
      const remainingDebt = outstandingDebt - recoveryApplied;
      await client.query(
        `UPDATE offerwall_gg_recovery_accounts
         SET outstanding_kobo = $2,
             total_recovered_kobo = total_recovered_kobo + $3::bigint,
             updated_at = NOW()
         WHERE user_id = $1`,
        [data.userId, remainingDebt.toString(), recoveryApplied.toString()]
      );
      await insertRecoveryLedger(client, {
        userId: data.userId,
        postbackId: conversionId,
        reference: 'OWGG-DEBT-REPAY-' + conversionId,
        eventType: 'debt_repaid',
        amountKobo: recoveryApplied
      });
    }

    await client.query(
      `UPDATE offerwall_gg_postbacks
       SET wallet_credit_kobo = $2, recovery_applied_kobo = $3
       WHERE id = $1`,
      [conversionId, walletCredit.toString(), recoveryApplied.toString()]
    );

    await client.query('COMMIT');
    return { status: 200, body: 'OK' };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    if (error.code === '23503') {
      return { status: 400, body: 'Unknown KC Earn user.' };
    }

    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  buildOfferwallGGWallUrl,
  calculateOfferwallGGRewardKobo,
  createOfferwallGGTables,
  handleOfferwallGGPostback,
  parseOfferwallGGCallback,
  verifyOfferwallGGSignature
};
