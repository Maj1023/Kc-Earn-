'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AFRICAN_COUNTRIES, getAfricanCountry } = require('../server/african-countries');

test('country catalog contains all 54 African countries with ISO currency codes', () => {
  assert.equal(AFRICAN_COUNTRIES.length, 54);
  assert.equal(new Set(AFRICAN_COUNTRIES.map(country => country.code)).size, 54);
  for (const country of AFRICAN_COUNTRIES) {
    assert.match(country.code, /^[A-Z]{2}$/);
    assert.match(country.currency, /^[A-Z]{3}$/);
    assert.ok(country.name.length > 1);
  }
});

test('country lookup normalizes codes and rejects unsupported locations', () => {
  assert.deepEqual(getAfricanCountry('ng'), { code: 'NG', name: 'Nigeria', currency: 'NGN' });
  assert.equal(getAfricanCountry('XX'), null);
  assert.equal(getAfricanCountry(null), null);
});
