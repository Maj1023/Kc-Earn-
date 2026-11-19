'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCurrencyMinorUnit, formatMinorAmount } = require('../server/currency');

test('currency precision follows ISO minor units for African currencies', () => {
  for (const currency of ['BIF', 'DJF', 'GNF', 'KMF', 'RWF', 'UGX', 'XAF', 'XOF']) {
    assert.equal(getCurrencyMinorUnit(currency), 0, currency);
  }
  for (const currency of ['NGN', 'KES', 'GHS', 'ZAR', 'EGP', 'MGA', 'ZWG']) {
    assert.equal(getCurrencyMinorUnit(currency), 2, currency);
  }
  for (const currency of ['LYD', 'TND']) {
    assert.equal(getCurrencyMinorUnit(currency), 3, currency);
  }
});

test('minor-unit formatting uses exact integer arithmetic at every precision', () => {
  assert.equal(formatMinorAmount('2866', 'NGN'), '28.66');
  assert.equal(formatMinorAmount('123', 'XOF'), '123');
  assert.equal(formatMinorAmount('-123', 'XAF'), '-123');
  assert.equal(formatMinorAmount('9007199254740993', 'KES'), '90071992547409.93');
  assert.equal(formatMinorAmount('12345', 'LYD'), '12.345');
  assert.equal(formatMinorAmount('-1', 'LYD'), '-0.001');
  assert.equal(formatMinorAmount('12345', 'TND'), '12.345');
});

test('unsupported currency and malformed minor-unit inputs are rejected', () => {
  assert.throws(() => getCurrencyMinorUnit('naira'), TypeError);
  assert.throws(() => getCurrencyMinorUnit('ZZZ'), TypeError);
  for (const value of ['1.2', '', ' ', '1e3', '1x', true, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatMinorAmount(value, 'NGN'), TypeError);
  }
});

const { AFRICAN_COUNTRIES, getAfricanCountry } = require('../server/african-countries');

test('the account country catalog covers all 54 African countries exactly once', () => {
  assert.equal(AFRICAN_COUNTRIES.length, 54);
  assert.equal(new Set(AFRICAN_COUNTRIES.map(country => country.code)).size, 54);
  assert.equal(getAfricanCountry('ng').currency, 'NGN');
  assert.equal(getAfricanCountry('CI').currency, 'XOF');
  assert.equal(getAfricanCountry('LY').currency, 'LYD');
  assert.equal(getAfricanCountry('TN').currency, 'TND');
  assert.equal(getAfricanCountry('XX'), null);
});

test('every African country has an explicitly supported currency and precision', () => {
  for (const country of AFRICAN_COUNTRIES) {
    assert.match(country.currency, /^[A-Z]{3}$/, country.code);
    assert.ok([0, 2, 3].includes(getCurrencyMinorUnit(country.currency)), country.code);
  }
});


const { calculateOfferzyRewardMinor } = require('../server/currency');

test('converts Offerzy Coins into local minor units using each currency precision', () => {
  // 25 Coins = USD 0.025; illustrative FX inputs are exact test fixtures only.
  assert.equal(calculateOfferzyRewardMinor('25', '600.00000000', 100, 'XOF'), '15');
  assert.equal(calculateOfferzyRewardMinor('25', '130.50000000', 100, 'KES'), '326');
  assert.equal(calculateOfferzyRewardMinor('25', '130.50000000', 100, 'LYD'), '3263');
  assert.equal(calculateOfferzyRewardMinor('25', '1500.00000000', 80, 'NGN'), '3000');
});

test('requires a valid local currency, positive FX rate and valid customer share', () => {
  assert.throws(() => calculateOfferzyRewardMinor('25', '0', 100, 'KES'));
  assert.throws(() => calculateOfferzyRewardMinor('25', '130.5', 101, 'KES'));
  assert.throws(() => calculateOfferzyRewardMinor('25', '130.5', 100, 'ZZZ'));
  assert.throws(() => calculateOfferzyRewardMinor('-25', '130.5', 100, 'KES'));
});

test('all African catalog currencies can be used by the generic reward calculator', () => {
  for (const country of AFRICAN_COUNTRIES) {
    const amount = calculateOfferzyRewardMinor('25', '100.00000000', 100, country.currency);
    assert.match(amount, /^[0-9]+$/, country.code);
  }
});
