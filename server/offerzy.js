'use strict';

const crypto = require('crypto');

const REQUIRED_FIELDS = [
  'user_id',
  'status',
  'reward',
  'payout',
  'transaction_id',
  'offer_id'
];

const REWARD_PATTERN = /^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/;
const PAYOUT_PATTERN = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
const MAX_BIGINT = 9223372036854775807n;

function isZeroAmount(value) {
  return /^-?0(?:\.0+)?$/.test(value);
}

function verifyOfferzySignature(data, privateKey, rawQuery) {
  if (!privateKey || typeof privateKey !== 'string') return false;

  // During Offerzy's signature migration, authenticate signature_v2 over the
  // exact raw query bytes preceding the final &signature_v2= parameter.
  if (data.signature_v2 !== undefined) {
    if (typeof rawQuery !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(data.signature_v2)) return false;

    const marker = '&signature_v2=';
    const markerIndex = rawQuery.lastIndexOf(marker);
    if (markerIndex <= 0 ||
        rawQuery.indexOf('signature_v2=') !== markerIndex + 1 ||
        !/^signature_v2=[a-f0-9]{64}$/i.test(rawQuery.slice(markerIndex + 1))) {
      return false;
    }

    const expected = crypto
      .createHmac('sha256', privateKey)
      .update(rawQuery.slice(0, markerIndex), 'utf8')
      .digest();
    const supplied = Buffer.from(data.signature_v2, 'hex');

    return supplied.length === expected.length &&
      crypto.timingSafeEqual(expected, supplied);
  }

  // Legacy MD5 remains available only when signature_v2 is absent.
  if (!/^[a-f0-9]{32}$/i.test(data.signature || '')) return false;
  const expected = crypto
    .createHash('md5')
    .update(data.user_id + data.reward + data.offer_id + privateKey, 'utf8')
    .digest();
  const supplied = Buffer.from(data.signature, 'hex');

  return supplied.length === expected.length &&
    crypto.timingSafeEqual(expected, supplied);
}

function parseOfferzyCallback(params) {
  const values = {};

  for (const [key, value] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return { error: 'Duplicate callback parameter: ' + key };
    }
    values[key] = value;
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof values[field] !== 'string' || values[field].length === 0) {
      return { error: 'Missing required callback parameter: ' + field };
    }
  }

  if (typeof values.signature !== 'string' || values.signature.length === 0) {
    if (typeof values.signature_v2 !== 'string' ||
        values.signature_v2.length === 0) {
      return { error: 'Missing required callback signature.' };
    }
  }

  if (!/^[1-9]\d{0,18}$/.test(values.user_id) ||
      BigInt(values.user_id) > MAX_BIGINT) {
    return { error: 'Invalid user_id.' };
  }

  if (values.status !== '1' && values.status !== '2') {
    return { error: 'Invalid callback status.' };
  }

  if (!REWARD_PATTERN.test(values.reward) ||
      !PAYOUT_PATTERN.test(values.payout)) {
    return { error: 'Invalid reward or payout amount.' };
  }

  if (isZeroAmount(values.reward) || isZeroAmount(values.payout)) {
    return { error: 'Reward and payout must be non-zero amounts.' };
  }

  if (values.status === '1' &&
      (values.reward.startsWith('-') || values.payout.startsWith('-'))) {
    return { error: 'Conversion amounts must be positive.' };
  }

  if (values.status === '2' &&
      (!values.reward.startsWith('-') || !values.payout.startsWith('-'))) {
    return { error: 'Reversal amounts must be negative.' };
  }

  if (values.transaction_id.length > 150 ||
      values.offer_id.length > 150 ||
      values.offer_name?.length > 255) {
    return { error: 'Callback identifier or offer name is too long.' };
  }

  for (const field of ['ip', 'country', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']) {
    const maxLength = field === 'ip' ? 64 :
      field === 'country' ? 32 : 255;
    if (values[field] && values[field].length > maxLength) {
      return { error: 'Callback metadata is too long.' };
    }
  }

  return {
    data: {
      user_id: values.user_id,
      status: Number(values.status),
      reward: values.reward,
      payout: values.payout,
      transaction_id: values.transaction_id,
      offer_id: values.offer_id,
      offer_name: values.offer_name || null,
      ip: values.ip || null,
      country: values.country || null,
      sub1: values.sub1 || null,
      sub2: values.sub2 || null,
      sub3: values.sub3 || null,
      sub4: values.sub4 || null,
      sub5: values.sub5 || null,
      signature: values.signature,
      signature_v2: values.signature_v2
    }
  };
}


function calculateOfferzyRewardKobo(rewardCoins, exchangeRate, rewardPercent) {
  const rewardPattern = /^(?:0|[1-9]\\d{0,17})(?:\\.\\d{1,8})?$/;
  const ratePattern = /^(?:0|[1-9]\\d{0,6})(?:\\.\\d{1,4})?$/;

  if (typeof rewardCoins !== 'string' || !rewardPattern.test(rewardCoins) ||
      /^0(?:\\.0+)?$/.test(rewardCoins)) {
    throw new Error('Invalid positive Offerzy Coin reward.');
  }

  if (typeof exchangeRate !== 'string' ||
      !ratePattern.test(exchangeRate)) {
    throw new Error('Invalid USD-to-NGN exchange rate.');
  }

  if (typeof rewardPercent !== 'number' ||
      !Number.isInteger(rewardPercent) ||
      rewardPercent < 0 || rewardPercent > 100) {
    throw new Error('Invalid customer reward percentage.');
  }

  function toScaledInteger(value, decimalPlaces) {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(decimalPlaces, '0'));
  }

  const coins = toScaledInteger(rewardCoins, 8);
  const rate = toScaledInteger(exchangeRate, 4);

  if (rate > 1000000n * 10000n) {
    throw new Error('Exchange rate exceeds the allowed maximum.');
  }

  // This placement defines 1,000 Offerzy Coins as USD 1.
  // Convert signed Coins to NGN, apply the customer share, then to kobo.
  const denominator = 1000000000000000n;
  const numerator = coins * rate * BigInt(rewardPercent);

  // Round half up to the nearest whole kobo.
  const rewardKobo = (numerator + denominator / 2n) / denominator;

  if (rewardKobo > MAX_BIGINT) {
    throw new Error('Calculated reward exceeds the wallet limit.');
  }

  return rewardKobo.toString();
}


async function handleOfferzyPostback({ rawQuery, params, pool, privateKey }) {
  if (!privateKey) {
    return { status: 503, body: 'Offerzy callback is not configured.' };
  }

  let callbackParams = params;
  if (typeof rawQuery === 'string') {
    callbackParams = new URLSearchParams(rawQuery);
  }
  if (!(callbackParams instanceof URLSearchParams)) {
    return { status: 400, body: 'Invalid callback query.' };
  }

  const parsed = parseOfferzyCallback(callbackParams);

  if (parsed.error) {
    return { status: 400, body: parsed.error };
  }

  const data = parsed.data;

  if (!verifyOfferzySignature(data, privateKey, rawQuery)) {
    return { status: 403, body: 'Invalid Offerzy signature.' };
  }

  // Offerzy's documented simulated test must never credit a real wallet.
  if (
    data.status === 1 &&
    data.transaction_id.startsWith('ofzy_test_') &&
    data.offer_id === 'ofzy_offer_test'
  ) {
    const customer = await pool.query(
      'SELECT id FROM users WHERE id = $1',
      [data.user_id]
    );

    if (!customer.rowCount) {
      return { status: 400, body: 'Unknown KC Earn test customer.' };
    }

    return { status: 200, body: 'Simulated test accepted; no wallet credit.' };
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    if (data.status === 2) {
      const originalResult = await client.query(
        `SELECT id, user_id::text, offer_id,
                reward_coins::text, payout_usd::text,
                wallet_credit_kobo::text,
                recovery_applied_kobo::text
         FROM offerzy_postbacks
         WHERE transaction_id = $1 AND status = 1
         FOR UPDATE`,
        [data.transaction_id]
      );

      if (!originalResult.rowCount) {
        await client.query('ROLLBACK');
        return {
          status: 409,
          body: 'Original conversion not found; reversal will need retrying.'
        };
      }

      const original = originalResult.rows[0];

      if (original.user_id !== data.user_id ||
          original.offer_id !== data.offer_id) {
        await client.query('ROLLBACK');
        return { status: 409, body: 'Reversal does not match its conversion.' };
      }

      const amountsMatch = await client.query(
        `SELECT
           $1::numeric = -$2::numeric AS reward_matches,
           $3::numeric = -$4::numeric AS payout_matches`,
        [
          original.reward_coins,
          data.reward,
          original.payout_usd,
          data.payout
        ]
      );

      if (!amountsMatch.rows[0].reward_matches ||
          !amountsMatch.rows[0].payout_matches) {
        await client.query('ROLLBACK');
        return {
          status: 409,
          body: 'Reversal amounts do not match the original conversion.'
        };
      }

      const inserted = await client.query(
        `INSERT INTO offerzy_postbacks (
           transaction_id, status, user_id, reward_coins, payout_usd,
           offer_id, offer_name, ip, country, sub1, sub2, sub3, sub4, sub5
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13, $14
         )
         ON CONFLICT (transaction_id, status) DO NOTHING
         RETURNING id`,
        [
          data.transaction_id, data.status, data.user_id,
          data.reward, data.payout, data.offer_id, data.offer_name,
          data.ip, data.country, data.sub1, data.sub2, data.sub3,
          data.sub4, data.sub5
        ]
      );

      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return { status: 200, body: 'duplicate' };
      }

      const reversalId = inserted.rows[0].id;
      const originalCredit = BigInt(original.wallet_credit_kobo || '0');
      const previouslyRecovered = BigInt(
        original.recovery_applied_kobo || '0'
      );

      await client.query(
        `INSERT INTO offerzy_recovery_accounts (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [data.user_id]
      );

      await client.query(
        `INSERT INTO wallets (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [data.user_id]
      );

      const recoveryResult = await client.query(
        `SELECT outstanding_kobo::text
         FROM offerzy_recovery_accounts
         WHERE user_id = $1
         FOR UPDATE`,
        [data.user_id]
      );

      const walletResult = await client.query(
        `SELECT balance_kobo::text
         FROM wallets
         WHERE user_id = $1
         FOR UPDATE`,
        [data.user_id]
      );

      const currentBalance = BigInt(walletResult.rows[0].balance_kobo);
      const currentDebt = BigInt(recoveryResult.rows[0].outstanding_kobo);

      const walletDebit = currentBalance < originalCredit
        ? currentBalance
        : originalCredit;

      const debtShortfall = originalCredit - walletDebit;
      const debtToRestore = previouslyRecovered;
      const newDebt = debtShortfall + debtToRestore;
      const updatedDebt = currentDebt + newDebt;

      if (updatedDebt > MAX_BIGINT) {
        throw new Error('Offerzy recovery debt exceeds the database limit.');
      }

      if (walletDebit > 0n) {
        await client.query(
          `UPDATE wallets
           SET balance_kobo = balance_kobo - $2::bigint,
               updated_at = NOW()
           WHERE user_id = $1`,
          [data.user_id, walletDebit.toString()]
        );

        await client.query(
          `INSERT INTO wallet_transactions (
             user_id, transaction_type, amount_kobo,
             description, reference
           ) VALUES ($1, 'debit', $2, $3, $4)`,
          [
            data.user_id,
            walletDebit.toString(),
            'Offerzy reward reversal',
            'OFZY-REV-' + reversalId
          ]
        );
      }

      if (newDebt > 0n) {
        await client.query(
          `UPDATE offerzy_recovery_accounts
           SET outstanding_kobo = outstanding_kobo + $2::bigint,
               updated_at = NOW()
           WHERE user_id = $1`,
          [data.user_id, newDebt.toString()]
        );
      }

      if (debtShortfall > 0n) {
        await client.query(
          `INSERT INTO offerzy_recovery_ledger (
             user_id, postback_id, reference, event_type, amount_kobo
           ) VALUES ($1, $2, $3, 'debt_added', $4)`,
          [
            data.user_id,
            reversalId,
            'OFZY-DEBT-ADD-' + reversalId,
            debtShortfall.toString()
          ]
        );
      }

      if (debtToRestore > 0n) {
        await client.query(
          `INSERT INTO offerzy_recovery_ledger (
             user_id, postback_id, reference, event_type, amount_kobo
           ) VALUES ($1, $2, $3, 'debt_restored', $4)`,
          [
            data.user_id,
            reversalId,
            'OFZY-DEBT-RESTORE-' + reversalId,
            debtToRestore.toString()
          ]
        );
      }

      await client.query(
        `UPDATE offerzy_postbacks
         SET wallet_debit_kobo = $2,
             recovery_added_kobo = $3,
             recovery_restored_kobo = $4
         WHERE id = $1`,
        [
          reversalId,
          walletDebit.toString(),
          debtShortfall.toString(),
          debtToRestore.toString()
        ]
      );

      await client.query('COMMIT');

      return { status: 200, body: 'ok' };
    }

    // Return duplicates successfully, even while new rewards are disabled.
    const existing = await client.query(
      `SELECT id FROM offerzy_postbacks
       WHERE transaction_id = $1 AND status = 1`,
      [data.transaction_id]
    );

    if (existing.rowCount) {
      await client.query('COMMIT');
      return { status: 200, body: 'duplicate' };
    }

    // Offerzy rewards are currently settled and accounted for in NGN only.
    // Never credit a non-Nigerian account with a mislabeled NGN amount.
    // Keep the callback retryable until that market has a verified local
    // currency conversion and payout route. Reversals above remain processable.
    const customerMarket = await client.query(
      'SELECT country_code FROM users WHERE id = $1 FOR SHARE',
      [data.user_id]
    );

    if (!customerMarket.rowCount) {
      await client.query('ROLLBACK');
      return { status: 400, body: 'Unknown KC Earn user.' };
    }

    if (customerMarket.rows[0].country_code !== 'NG') {
      await client.query('ROLLBACK');
      return {
        status: 503,
        body: 'Rewards are not yet enabled for this country; retry later.'
      };
    }

    // Lock settings so the rate and percentage cannot change mid-credit.
    const settingsResult = await client.query(
      `SELECT user_reward_percent,
              usd_to_ngn_rate::text AS usd_to_ngn_rate,
              rewards_enabled
       FROM reward_settings
       WHERE id = 1
       FOR SHARE`
    );

    if (settingsResult.rowCount !== 1) {
      throw new Error('Reward settings are not initialized.');
    }

    const settings = settingsResult.rows[0];

    if (settings.rewards_enabled !== true) {
      await client.query('ROLLBACK');
      return {
        status: 503,
        body: 'Offerzy rewards are temporarily disabled.'
      };
    }

    const rewardPercent = Number(settings.user_reward_percent);
    const exchangeRate = settings.usd_to_ngn_rate;

    const grossReward = BigInt(
      calculateOfferzyRewardKobo(
        data.reward,
        exchangeRate,
        rewardPercent
      )
    );

    const inserted = await client.query(
      `INSERT INTO offerzy_postbacks (
         transaction_id, status, user_id, reward_coins, payout_usd,
         offer_id, offer_name, ip, country, sub1, sub2, sub3, sub4, sub5,
         usd_to_ngn_rate, user_reward_percent, calculated_reward_kobo
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17
       )
       ON CONFLICT (transaction_id, status) DO NOTHING
       RETURNING id`,
      [
        data.transaction_id, data.status, data.user_id,
        data.reward, data.payout, data.offer_id, data.offer_name,
        data.ip, data.country, data.sub1, data.sub2, data.sub3,
        data.sub4, data.sub5, exchangeRate, rewardPercent,
        grossReward.toString()
      ]
    );

    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { status: 200, body: 'duplicate' };
    }

    const conversionId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO offerzy_recovery_accounts (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [data.user_id]
    );

    await client.query(
      `INSERT INTO wallets (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [data.user_id]
    );

    const recoveryResult = await client.query(
      `SELECT outstanding_kobo::text
       FROM offerzy_recovery_accounts
       WHERE user_id = $1
       FOR UPDATE`,
      [data.user_id]
    );

    const walletResult = await client.query(
      `SELECT balance_kobo::text
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [data.user_id]
    );

    const outstandingDebt = BigInt(
      recoveryResult.rows[0].outstanding_kobo
    );

    const recoveryApplied = grossReward < outstandingDebt
      ? grossReward
      : outstandingDebt;

    const walletCredit = grossReward - recoveryApplied;
    const remainingDebt = outstandingDebt - recoveryApplied;

    if (walletCredit > 0n) {
      const newBalance =
        BigInt(walletResult.rows[0].balance_kobo) + walletCredit;

      if (newBalance > MAX_BIGINT) {
        throw new Error('Wallet balance exceeds the database limit.');
      }

      await client.query(
        `UPDATE wallets
         SET balance_kobo = balance_kobo + $2::bigint,
             updated_at = NOW()
         WHERE user_id = $1`,
        [data.user_id, walletCredit.toString()]
      );

      await client.query(
        `INSERT INTO wallet_transactions (
           user_id, transaction_type, amount_kobo,
           description, reference
         ) VALUES ($1, 'credit', $2, $3, $4)`,
        [
          data.user_id,
          walletCredit.toString(),
          'Verified Offerzy reward',
          'OFZY-CREDIT-' + conversionId
        ]
      );
    }

    if (recoveryApplied > 0n) {
      const totalRecoveredResult = await client.query(
        `SELECT total_recovered_kobo::text
         FROM offerzy_recovery_accounts
         WHERE user_id = $1`,
        [data.user_id]
      );

      const totalRecovered =
        BigInt(totalRecoveredResult.rows[0].total_recovered_kobo) +
        recoveryApplied;

      if (totalRecovered > MAX_BIGINT) {
        throw new Error('Total recovery amount exceeds the database limit.');
      }

      await client.query(
        `UPDATE offerzy_recovery_accounts
         SET outstanding_kobo = $2,
             total_recovered_kobo = total_recovered_kobo + $3::bigint,
             updated_at = NOW()
         WHERE user_id = $1`,
        [
          data.user_id,
          remainingDebt.toString(),
          recoveryApplied.toString()
        ]
      );

      await client.query(
        `INSERT INTO offerzy_recovery_ledger (
           user_id, postback_id, reference, event_type, amount_kobo
         ) VALUES ($1, $2, $3, 'debt_repaid', $4)`,
        [
          data.user_id,
          conversionId,
          'OFZY-DEBT-REPAY-' + conversionId,
          recoveryApplied.toString()
        ]
      );
    }

    await client.query(
      `UPDATE offerzy_postbacks
       SET wallet_credit_kobo = $2,
           recovery_applied_kobo = $3
       WHERE id = $1`,
      [
        conversionId,
        walletCredit.toString(),
        recoveryApplied.toString()
      ]
    );

    await client.query('COMMIT');

    return { status: 200, body: 'ok' };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    if (error.code === '23503') {
      return { status: 400, body: 'Unknown KC Earn user.' };
    }

    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  verifyOfferzySignature,
  parseOfferzyCallback,
  calculateOfferzyRewardKobo,
  handleOfferzyPostback
};
