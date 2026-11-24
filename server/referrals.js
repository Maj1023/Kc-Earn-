'use strict';

const crypto = require('node:crypto');

const REFERRAL_CODE_LENGTH = 16;
const REFERRAL_CODE_PATTERN = /^[A-F0-9]{16}$/;
const REQUIRED_REFERRALS = 5;

function generateReferralCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function normalizeReferralCode(value) {
  if (typeof value !== 'string') return null;

  const code = value.trim().toUpperCase();

  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

function isValidReferralCode(value) {
  return normalizeReferralCode(value) !== null;
}

function getReferralEligibility(successfulReferrals, isOwner = false) {
  const count = Number(successfulReferrals);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError('Referral count must be a non-negative integer.');
  }

  return {
    successfulReferrals: count,
    requiredReferrals: REQUIRED_REFERRALS,
    remainingReferrals: isOwner ? 0 : Math.max(0, REQUIRED_REFERRALS - count),
    eligible: isOwner || count >= REQUIRED_REFERRALS
  };
}

module.exports = {
  REFERRAL_CODE_LENGTH,
  REQUIRED_REFERRALS,
  generateReferralCode,
  normalizeReferralCode,
  isValidReferralCode,
  getReferralEligibility
};
