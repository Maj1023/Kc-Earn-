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
});

test('minor-unit formatting never uses floating-point arithmetic', () => {
  assert.equal(formatMinorAmount('2866', 'NGN'), '28.66');
  assert.equal(formatMinorAmount('123', 'XOF'), '123');
  assert.equal(formatMinorAmount('-123', 'XAF'), '-123');
  assert.equal(formatMinorAmount('9007199254740993', 'KES'), '90071992547409.93');
});

test('invalid currency and fractional minor-unit inputs are rejected', () => {
  assert.throws(() => getCurrencyMinorUnit('naira'), TypeError);
  assert.throws(() => formatMinorAmount('1.2', 'NGN'), TypeError);
});

const { AFRICAN_COUNTRIES, getAfricanCountry } = require('../server/african-countries');

test('the account country catalog covers all 54 African countries exactly once', () => {
  assert.equal(AFRICAN_COUNTRIES.length, 54);
  assert.equal(new Set(AFRICAN_COUNTRIES.map(country => country.code)).size, 54);
  assert.equal(getAfricanCountry('ng').currency, 'NGN');
  assert.equal(getAfricanCountry('CI').currency, 'XOF');
  assert.equal(getAfricanCountry('XX'), null);
});

test('every African country has a valid currency and supported minor-unit precision', () => {
  for (const country of AFRICAN_COUNTRIES) {
    assert.match(country.currency, /^[A-Z]{3}$/, country.code);
    assert.ok([0, 2].includes(getCurrencyMinorUnit(country.currency)), country.code);
  }
});
