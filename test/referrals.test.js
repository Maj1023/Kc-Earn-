'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateReferralCode,
  normalizeReferralCode,
  isValidReferralCode,
  getReferralEligibility
} = require('../server/referrals');

test('generates unique-format 16-character referral codes', () => {
  const first = generateReferralCode();
  const second = generateReferralCode();

  assert.match(first, /^[A-F0-9]{16}$/);
  assert.match(second, /^[A-F0-9]{16}$/);
  assert.notEqual(first, second);
});

test('normalizes valid referral codes', () => {
  assert.equal(
    normalizeReferralCode('  abcdef0123456789  '),
    'ABCDEF0123456789'
  );
});

test('rejects malformed referral codes', () => {
  assert.equal(normalizeReferralCode(''), null);
  assert.equal(normalizeReferralCode('short'), null);
  assert.equal(normalizeReferralCode('123456789012345G'), null);
  assert.equal(normalizeReferralCode(null), null);
  assert.equal(isValidReferralCode('not-a-code'), false);
});

test('requires five successful registrations for normal users', () => {
  assert.equal(getReferralEligibility(0).eligible, false);
  assert.equal(getReferralEligibility(3).remainingReferrals, 2);
  assert.equal(getReferralEligibility(4).eligible, false);
  assert.equal(getReferralEligibility(5).eligible, true);
});

test('Owner is exempt from the referral requirement', () => {
  const result = getReferralEligibility(0, true);

  assert.equal(result.eligible, true);
  assert.equal(result.remainingReferrals, 0);
});

test('rejects invalid referral counts', () => {
  assert.throws(() => getReferralEligibility(-1), TypeError);
  assert.throws(() => getReferralEligibility(NaN), TypeError);
});
