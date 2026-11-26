'use strict';

const crypto = require('node:crypto');

const MAX_BIGINT = 9223372036854775807n;

function verifyAdGemSignature(rawBody, signature, postbackKey) {
  if (!Buffer.isBuffer(rawBody) || !signature || !postbackKey) {
    return false;
  }

  const supplied = String(signature).trim();

  if (!/^[a-f0-9]{64}$/i.test(supplied)) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', postbackKey)
    .update(rawBody)
    .digest();

  const received = Buffer.from(supplied, 'hex');

  return received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
}

function parseAdGemPostback(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('Invalid JSON payload');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.data ||
    typeof payload.data !== 'object'
  ) {
    throw new Error('Invalid AdGem payload');
  }

  const data = payload.data;

  if (data.conversion_type === 'install') {
    return { ignored: true, reason: 'install_event' };
  }

  if (data.conversion_type !== 'reward') {
    throw new Error('Unsupported AdGem conversion type');
  }

  const playerId = String(data.player_id ?? '').trim();
  const conversionId = String(data.conversion_id ?? '').trim();
  const payout = String(data.payout ?? '').trim();
  const amount = String(data.amount ?? '').trim();

  if (!/^[1-9]\d*$/.test(playerId)) {
    throw new Error('Invalid AdGem player_id');
  }

  if (!conversionId || conversionId.length > 255) {
    throw new Error('Invalid AdGem conversion_id');
  }

  if (!/^\d+(?:\.\d{1,8})?$/.test(payout) || Number(payout) <= 0) {
    throw new Error('Invalid AdGem payout');
  }

  if (!/^\d+(?:\.\d{1,8})?$/.test(amount) || Number(amount) < 0) {
    throw new Error('Invalid AdGem amount');
  }

  return {
    ignored: false,
    playerId,
    conversionId,
    payout,
    amount,
    campaignId: data.campaign_id == null ? null : String(data.campaign_id),
    offerId: data.offer_id == null ? null : String(data.offer_id),
    offerName: data.offer_name == null ? null : String(data.offer_name),
    country: data.country == null ? null : String(data.country),
    goalId: data.goal_id == null ? null : String(data.goal_id),
    goalName: data.goal_name == null ? null : String(data.goal_name),
    requestId: payload.request_id == null ? null : String(payload.request_id),
    timestamp: payload.timestamp == null ? null : String(payload.timestamp)
  };
}

function decimalToScaled(value, decimals) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
}

function calculateAdGemRewardKobo(payoutUsd, exchangeRate, rewardPercent) {
  if (
    !/^\d+(?:\.\d{1,8})?$/.test(String(payoutUsd)) ||
    !/^\d+(?:\.\d{1,4})?$/.test(String(exchangeRate))
  ) {
    throw new Error('Invalid reward calculation values');
  }

  const percent = Number(rewardPercent);

  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error('Invalid user reward percentage');
  }

  const payoutScaled = decimalToScaled(payoutUsd, 8);
  const rateScaled = decimalToScaled(exchangeRate, 4);

  // USD payout × NGN exchange rate × reward percentage
  // gives the user's reward directly in kobo.
  const numerator = payoutScaled * rateScaled * BigInt(percent);
  const denominator = 1000000000000n;

  const result = (numerator + denominator / 2n) / denominator;

  if (result < 0n || result > MAX_BIGINT) {
    throw new Error('Calculated reward exceeds database limits');
  }

  return result;
}

async function createAdGemTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS adgem_postbacks (
      id BIGSERIAL PRIMARY KEY,
      conversion_id VARCHAR(255) NOT NULL UNIQUE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      payout_usd NUMERIC(20,8) NOT NULL,
      amount NUMERIC(20,8) NOT NULL,
      campaign_id VARCHAR(150),
      offer_id VARCHAR(150),
      offer_name VARCHAR(255),
      country VARCHAR(10),
      goal_id VARCHAR(100),
      goal_name VARCHAR(255),
      request_id VARCHAR(255),
      calculated_reward_kobo BIGINT NOT NULL
        CHECK (calculated_reward_kobo >= 0),
      wallet_credit_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (wallet_credit_kobo >= 0),
      recovery_applied_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (recovery_applied_kobo >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS adgem_postbacks_user_created_idx
    ON adgem_postbacks(user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS adgem_recovery_accounts (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      outstanding_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (outstanding_kobo >= 0),
      total_recovered_kobo BIGINT NOT NULL DEFAULT 0
        CHECK (total_recovered_kobo >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS adgem_recovery_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      postback_id BIGINT NOT NULL REFERENCES adgem_postbacks(id)
        ON DELETE RESTRICT,
      reference VARCHAR(100) NOT NULL UNIQUE,
      event_type VARCHAR(20) NOT NULL
        CHECK (event_type IN ('debt_repaid')),
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function handleAdGemPostback({
  rawBody,
  signature,
  pool,
  postbackKey
}) {
  if (!verifyAdGemSignature(rawBody, signature, postbackKey)) {
    return { status: 401, body: 'Invalid signature' };
  }

  let data;

  try {
    data = parseAdGemPostback(rawBody);
  } catch (error) {
    return { status: 400, body: error.message };
  }

  if (data.ignored) {
    return { status: 200, body: 'ignored' };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const settingsResult = await client.query(`
      SELECT user_reward_percent, usd_to_ngn_rate, rewards_enabled
      FROM reward_settings
      FOR SHARE
    `);

    if (!settingsResult.rowCount) {
      throw new Error('Reward settings are unavailable');
    }

    const settings = settingsResult.rows[0];

    if (!settings.rewards_enabled) {
      await client.query('ROLLBACK');
      return { status: 503, body: 'Rewards are temporarily disabled' };
    }

    const rewardKobo = calculateAdGemRewardKobo(
      data.payout,
      settings.usd_to_ngn_rate,
      settings.user_reward_percent
    );

    const inserted = await client.query(
      `INSERT INTO adgem_postbacks (
         conversion_id, user_id, payout_usd, amount,
         campaign_id, offer_id, offer_name, country,
         goal_id, goal_name, request_id, calculated_reward_kobo
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       )
       ON CONFLICT (conversion_id) DO NOTHING
       RETURNING id`,
      [
        data.conversionId,
        data.playerId,
        data.payout,
        data.amount,
        data.campaignId,
        data.offerId,
        data.offerName,
        data.country,
        data.goalId,
        data.goalName,
        data.requestId,
        rewardKobo.toString()
      ]
    );

    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { status: 200, body: 'duplicate' };
    }

    const postbackId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO adgem_recovery_accounts (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [data.playerId]
    );

    await client.query(
      `INSERT INTO wallets (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [data.playerId]
    );

    const recoveryResult = await client.query(
      `SELECT outstanding_kobo::text
       FROM adgem_recovery_accounts
       WHERE user_id = $1
       FOR UPDATE`,
      [data.playerId]
    );

    const walletResult = await client.query(
      `SELECT balance_kobo::text
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [data.playerId]
    );

    const outstanding = BigInt(recoveryResult.rows[0].outstanding_kobo);
    const balance = BigInt(walletResult.rows[0].balance_kobo);

    const recoveryApplied = outstanding < rewardKobo
      ? outstanding
      : rewardKobo;

    const walletCredit = rewardKobo - recoveryApplied;

    if (balance + walletCredit > MAX_BIGINT) {
      throw new Error('Wallet balance exceeds database limits');
    }

    if (recoveryApplied > 0n) {
      await client.query(
        `UPDATE adgem_recovery_accounts
         SET outstanding_kobo = outstanding_kobo - $2::bigint,
             total_recovered_kobo = total_recovered_kobo + $2::bigint,
             updated_at = NOW()
         WHERE user_id = $1`,
        [data.playerId, recoveryApplied.toString()]
      );

      await client.query(
        `INSERT INTO adgem_recovery_ledger (
           user_id, postback_id, reference, event_type, amount_kobo
         ) VALUES ($1, $2, $3, 'debt_repaid', $4)`,
        [
          data.playerId,
          postbackId,
          `ADGEM-REC-${postbackId}`,
          recoveryApplied.toString()
        ]
      );
    }

    if (walletCredit > 0n) {
      await client.query(
        `UPDATE wallets
         SET balance_kobo = balance_kobo + $2::bigint,
             updated_at = NOW()
         WHERE user_id = $1`,
        [data.playerId, walletCredit.toString()]
      );

      await client.query(
        `INSERT INTO wallet_transactions (
           user_id, transaction_type, amount_kobo,
           description, reference
         ) VALUES ($1, 'credit', $2, $3, $4)`,
        [
          data.playerId,
          walletCredit.toString(),
          'AdGem reward',
          `ADGEM-${postbackId}`
        ]
      );
    }

    await client.query(
      `UPDATE adgem_postbacks
       SET wallet_credit_kobo = $2,
           recovery_applied_kobo = $3
       WHERE id = $1`,
      [
        postbackId,
        walletCredit.toString(),
        recoveryApplied.toString()
      ]
    );

    await client.query('COMMIT');

    return { status: 200, body: 'credited' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('AdGem postback processing failed:', error.message);

    return { status: 500, body: 'Postback processing failed' };
  } finally {
    client.release();
  }
}

module.exports = {
  verifyAdGemSignature,
  parseAdGemPostback,
  calculateAdGemRewardKobo,
  createAdGemTables,
  handleAdGemPostback
};
