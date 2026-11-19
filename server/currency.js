'use strict';

// ISO 4217 minor-unit precision for currencies used by the African country catalog.
// Most currencies use 2 decimal places; these currencies use whole major units.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'DJF', 'GNF', 'KMF', 'RWF', 'UGX', 'XAF', 'XOF'
]);

function getCurrencyMinorUnit(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('A valid ISO 4217 currency code is required.');
  }
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

function formatMinorAmount(amountMinor, currency) {
  const digits = getCurrencyMinorUnit(currency);
  let amount;
  try {
    amount = BigInt(amountMinor);
  } catch {
    throw new TypeError('Amount must be an integer number of minor units.');
  }
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  if (digits === 0) return (negative ? '-' : '') + absolute.toString();
  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + fraction;
}

module.exports = { getCurrencyMinorUnit, formatMinorAmount };
