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

function getCurrencyMinorUnit(currency) {
  if (typeof currency !== 'string' || !Object.hasOwn(CURRENCY_MINOR_UNITS, currency)) {
    throw new TypeError('A supported ISO 4217 currency code is required.');
  }
  return CURRENCY_MINOR_UNITS[currency];
}

function formatMinorAmount(amountMinor, currency) {
  const digits = getCurrencyMinorUnit(currency);
  if (!(typeof amountMinor === 'bigint' ||
        (typeof amountMinor === 'number' && Number.isSafeInteger(amountMinor)) ||
        (typeof amountMinor === 'string' && /^-?[0-9]+$/.test(amountMinor))) {
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

module.exports = { getCurrencyMinorUnit, formatMinorAmount };
