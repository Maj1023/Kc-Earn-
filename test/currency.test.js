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
