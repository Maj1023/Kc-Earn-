'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  buildOfferwallGGWallUrl,
  calculateOfferwallGGRewardKobo,
  handleOfferwallGGPostback,
  parseOfferwallGGCallback,
  verifyOfferwallGGSignature
} = require('../server/offerwall-gg');

const SECRET = crypto.randomBytes(32).toString('hex');
const PUBLIC_KEY = 'a'.repeat(32);

function makeCallback(overrides = {}) {
  const values = {
    userId: '42',
    transactionId: 'owgg-test-transaction',
    currencyAmount: '250.0000',
    currencyName: 'Points',
    offerId: 'offer-test',
    offerName: 'Test offer',
    goalId: '',
    payoutUsd: '0.250000',
    status: 'credited',
    test: '0',
    timestamp: '1760000000',
    ...overrides
  };
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(
      `${values.userId}:${values.transactionId}:${values.currencyAmount}`,
      'utf8'
    )
    .digest('hex');
  const parameters = new URLSearchParams({
    ...values,
    signature
  });

  return {
    values,
    signature,
    rawParameters: parameters.toString()
  };
}

test('verifies Offerwall.GG signature over the documented three fields', () => {
  const callback = makeCallback();
  const parsed = parseOfferwallGGCallback(
    callback.rawParameters,
    SECRET
  );

  assert.ok(parsed.data);
  assert.equal(parsed.data.userId, '42');
  assert.equal(parsed.data.currencyAmount, '250.0000');
  assert.equal(
    verifyOfferwallGGSignature({
      userId: '42',
      transactionId: callback.values.transactionId,
      currencyAmount: callback.values.currencyAmount,
      signature: callback.signature
    }, SECRET),
    true
  );
  assert.match(
    parseOfferwallGGCallback(
      callback.rawParameters.replace('250.0000', '250.1000'),
      SECRET
    ).error,
    /signature/
  );
});

test('rejects duplicate, unknown, malformed and status-mismatched callback data', () => {
  const callback = makeCallback();

  assert.match(
    parseOfferwallGGCallback(
      callback.rawParameters + '&userId=43',
      SECRET
    ).error,
    /Duplicate/
  );
  assert.match(
    parseOfferwallGGCallback(
      callback.rawParameters + '&unexpected=value',
      SECRET
    ).error,
    /Unexpected/
  );
  assert.match(
    parseOfferwallGGCallback(
      callback.rawParameters.replace('currencyAmount=250.0000', 'currencyAmount=1e5'),
      SECRET
    ).error,
    /signature/
  );

  const badStatus = makeCallback({ status: 'reversed' });
  assert.match(
    parseOfferwallGGCallback(badStatus.rawParameters, SECRET).error,
    /sign do not match/
  );
});

test('rejects unsigned and invalid signatures', () => {
  const callback = makeCallback();
  assert.equal(
    verifyOfferwallGGSignature({
      userId: '42',
      transactionId: callback.values.transactionId,
      currencyAmount: callback.values.currencyAmount,
      signature: '0'.repeat(64)
    }, SECRET),
    false
  );
  assert.equal(
    verifyOfferwallGGSignature({
      userId: '42',
      transactionId: callback.values.transactionId,
      currencyAmount: callback.values.currencyAmount,
      signature: callback.signature
    }, ''),
    false
  );
});

test('does not trust payoutUsd because the provider signature does not cover it', () => {
  const callback = makeCallback();
  const changedPayout = callback.rawParameters.replace(
    'payoutUsd=0.250000',
    'payoutUsd=999999.000000'
  );
  const parsed = parseOfferwallGGCallback(changedPayout, SECRET);

  assert.ok(parsed.data);
  assert.equal(parsed.data.currencyAmount, '250.0000');
});

test('builds a signed hosted-wall URL without disclosing the secret', () => {
  const url = new URL(buildOfferwallGGWallUrl({
    publicKey: PUBLIC_KEY,
    secretKey: SECRET,
    unitsPerUsd: '1000',
    userId: '42'
  }));
  const signature = url.searchParams.get('signature');
  const parsed = Object.fromEntries(url.searchParams.entries());

  delete parsed.signature;
  assert.equal(url.origin, 'https://offerwall.gg');
  assert.equal(url.pathname, `/wall/${PUBLIC_KEY}`);
  assert.equal(parsed.appId, PUBLIC_KEY);
  assert.equal(parsed.userId, '42');
  assert.equal(
    signature,
    crypto.createHmac('sha256', SECRET)
      .update('appId=' + PUBLIC_KEY + '&userId=42')
      .digest('hex')
  );
  assert.equal(url.href.includes(SECRET), false);
});

test('includes a signed Unix timestamp when link expiry is enabled', () => {
  const url = new URL(buildOfferwallGGWallUrl({
    publicKey: PUBLIC_KEY,
    secretKey: SECRET,
    unitsPerUsd: '1000',
    userId: '42',
    timestampedLinks: true,
    now: 1760000000000
  }));
  const parameters = {
    appId: url.searchParams.get('appId'),
    userId: url.searchParams.get('userId'),
    ts: url.searchParams.get('ts')
  };
  const canonical = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  assert.equal(parameters.ts, '1760000000');
  assert.equal(
    url.searchParams.get('signature'),
    crypto.createHmac('sha256', SECRET).update(canonical).digest('hex')
  );
});

test('requires the placement currency rate before issuing a wall URL', () => {
  assert.throws(
    () => buildOfferwallGGWallUrl({
      publicKey: PUBLIC_KEY,
      secretKey: SECRET,
      userId: '42'
    }),
    /OFFERWALL_GG_UNITS_PER_USD/
  );
});

test('calculates exact wallet kobo from configured placement units and admin settings', () => {
  assert.equal(
    calculateOfferwallGGRewardKobo(
      '250.0000',
      '1000',
      '1500.0000',
      80
    ),
    30000n
  );
  assert.equal(
    calculateOfferwallGGRewardKobo(
      '0.0001',
      '1000',
      '1500.0000',
      80
    ),
    0n
  );
  assert.throws(
    () => calculateOfferwallGGRewardKobo(
      '250.0000',
      '',
      '1500.0000',
      80
    ),
    /OFFERWALL_GG_UNITS_PER_USD/
  );
});

test('test postbacks are acknowledged without database access', async () => {
  const callback = makeCallback({
    userId: 'test-user-1',
    test: '1'
  });
  const result = await handleOfferwallGGPostback({
    rawParameters: callback.rawParameters,
    secretKey: SECRET,
    pool: {
      connect() {
        assert.fail('Test callback must not access the database.');
      }
    }
  });

  assert.deepEqual(result, { status: 200, body: 'OK' });
});

test('missing configuration fails closed', async () => {
  const callback = makeCallback();
  const result = await handleOfferwallGGPostback({
    rawParameters: callback.rawParameters,
    secretKey: SECRET,
    pool: {
      connect() {
        assert.fail('Invalid configuration must not access the database.');
      }
    }
  });

  assert.equal(result.status, 503);
});
