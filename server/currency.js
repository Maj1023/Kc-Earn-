'use strict';

// ISO 4217 minor-unit precision for currencies used by the African country catalog.
// Keep this explicit: unknown codes must never silently inherit two-decimal precision.
const CURRENCY_MINOR_UNITS = Object.freeze({
  AOA: 2, BIF: 0, BWP: 2, CDF: 2, CVE: 2, DJF: 0, DZD: 2,
  EGP: 2, ERN: 2, ETB: 2, GHS: 2, GMD: 2, GNF: 0, KES: 2,
  KMF: 0, LRD: 2, LSL: 2, LYD: 3, MAD: 2, MGA: 2, MRU: 2,
  MUR: 2, MWK: 2, MZN: 2, NAD: 2, NGN: 2, RWF: 0, SCR: 2,
  SDG: 2, SLE: 2, SOS: 2, SSP: 2, STN: 2, SZL: 2, TND: 3,
  TZS: 2, UGX: 0, XAF: 0, XOF: 0, ZAR: 2, ZMW: 2, ZWG: 2
});

const MAX_BIGINT = 9223372036854775807n;

function getCurrencyMinorUnit(currency) {
  if (typeof currency !== 'string' || !Object.hasOwn(CURRENCY_MINOR_UNITS, currency)) {
    throw new TypeError('A supported ISO 4217 currency code is required.');
  }
  return CURRENCY_MINOR_UNITS[currency];
}

function formatMinorAmount(amountMinor, currency) {
  const digits = getCurrencyMinorUnit(currency);
  const isIntegerMinorAmount =
    typeof amountMinor === 'bigint' ||
    (typeof amountMinor === 'number' && Number.isSafeInteger(amountMinor)) ||
    (typeof amountMinor === 'string' && /^-?[0-9]+$/.test(amountMinor));

  if (!isIntegerMinorAmount) {
    throw new TypeError('Amount must be an integer number of minor units.');
  }

  const amount = BigInt(amountMinor);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  if (digits === 0) return (negative ? '-' : '') + absolute.toString();
  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + fraction;
}

// Convert signed Offerzy Coin rewards to a country's integer minor units.
// Offerzy confirms 1,000 Coins = USD 1. The caller must supply a trusted,
// current USD-to-local-currency rate; no guessed or hard-coded FX rate is used.
// The caller must keep the FX rate and currency metadata with the ledger entry.
function calculateOfferzyRewardMinor(rewardCoins, usdToLocalRate, rewardPercent, currency) {
  const digits = getCurrencyMinorUnit(currency);
  const coinPattern = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/;
  const ratePattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;

  if (typeof rewardCoins !== 'string' || !coinPattern.test(rewardCoins) ||
      /^0(?:\.0+)?$/.test(rewardCoins)) {
    throw new Error('Invalid positive Offerzy Coin reward.');
  }
  if (typeof usdToLocalRate !== 'string' || !ratePattern.test(usdToLocalRate) ||
      /^0(?:\.0+)?$/.test(usdToLocalRate)) {
    throw new Error('A positive trusted USD-to-local-currency rate is required.');
  }
  if (typeof rewardPercent !== 'number' || !Number.isInteger(rewardPercent) ||
      rewardPercent < 0 || rewardPercent > 100) {
    throw new Error('Invalid customer reward percentage.');
  }

  function toScaledInteger(value, places) {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(places, '0'));
  }

  const coins = toScaledInteger(rewardCoins, 8);
  const rate = toScaledInteger(usdToLocalRate, 8);
  if (rate > 1000000000n * 100000000n) {
    throw new Error('Exchange rate exceeds the allowed maximum.');
  }

  // Minor units = Coins / 1,000 * USD/local rate * customer share * 10^digits.
  const numerator = coins * rate * BigInt(rewardPercent) * (10n ** BigInt(digits));
  const denominator = 1000000000000000000000n; // 10^8 * 10^8 * 1,000 * 100
  const amountMinor = (numerator + denominator / 2n) / denominator;

  if (amountMinor > MAX_BIGINT) {
    throw new Error('Calculated reward exceeds the wallet limit.');
  }
  return amountMinor.toString();
}

module.exports = {
  getCurrencyMinorUnit,
  formatMinorAmount,
  calculateOfferzyRewardMinor
};
