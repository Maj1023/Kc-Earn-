const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  verifyAdGemSignature,
  parseAdGemPostback,
  calculateAdGemRewardKobo
} = require('../server/adgem');

const secret = 'local-test-secret';

function createPayload(overrides = {}) {
  return Buffer.from(JSON.stringify({
    request_id: 'test-request',
    timestamp: 1764150000,
    data: {
      conversion_type: 'reward',
      player_id: '1',
      conversion_id: 'test-conversion-001',
      payout: '1.00',
      amount: '100',
      campaign_id: 'test-campaign',
      ...overrides
    }
  }));
}

function sign(body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('accepts a valid AdGem HMAC signature', () => {
  const body = createPayload();
  assert.equal(verifyAdGemSignature(body, sign(body), secret), true);
});

test('rejects an invalid AdGem signature', () => {
  assert.equal(verifyAdGemSignature(createPayload(), 'invalid', secret), false);
});

test('rejects a modified request body', () => {
  const body = createPayload();
  const signature = sign(body);
  const modified = Buffer.from(body.toString().replace('1.00', '2.00'));

  assert.equal(verifyAdGemSignature(modified, signature, secret), false);
});

test('parses a reward conversion', () => {
  const parsed = parseAdGemPostback(createPayload());

  assert.equal(parsed.playerId, '1');
  assert.equal(parsed.conversionId, 'test-conversion-001');
  assert.equal(parsed.payout, '1.00');
});

test('ignores install-only events', () => {
  const body = Buffer.from(JSON.stringify({
    data: { conversion_type: 'install' }
  }));

  assert.equal(parseAdGemPostback(body).ignored, true);
});

test('calculates the user reward in kobo correctly', () => {
  assert.equal(calculateAdGemRewardKobo('1.00', '1500', 70), 105000n);
});

test('returns zero when the reward percentage is zero', () => {
  assert.equal(calculateAdGemRewardKobo('1.00', '1500', 0), 0n);
});
