'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isMobileClient, isAllowedApiPost } = require('../server/mobile-auth');

const origin = 'https://kc-earn.example.com';
const token = 'a'.repeat(64);

test('recognizes explicit native mobile requests without an Origin header', () => {
  assert.equal(isMobileClient({ headers: { 'x-kc-client': 'mobile' } }), true);
  assert.equal(isMobileClient({ headers: { 'x-kc-client': 'mobile', origin } }), false);
  assert.equal(isMobileClient({ headers: {} }), false);
});

test('allows browser POSTs only when Origin matches the configured origin', () => {
  assert.equal(isAllowedApiPost({ headers: { origin } }, origin), true);
  assert.equal(isAllowedApiPost({ headers: { origin: 'https://attacker.example' } }, origin), false);
  assert.equal(isAllowedApiPost({ headers: { origin: 'not a url' } }, origin), false);
});

test('allows native registration and login without a pre-existing bearer token', () => {
  const req = { headers: { 'x-kc-client': 'mobile' } };
  assert.equal(isAllowedApiPost(req, origin, true), true);
  assert.equal(isAllowedApiPost(req, origin, false), false);
});

test('requires bearer authentication for native POSTs after login', () => {
  assert.equal(isAllowedApiPost({ headers: { authorization: 'Bearer ' + token } }, origin), true);
  assert.equal(isAllowedApiPost({ headers: { authorization: 'Bearer invalid' } }, origin), false);
  assert.equal(isAllowedApiPost({ headers: {} }, origin), false);
  assert.equal(isAllowedApiPost({ headers: { 'x-kc-client': 'mobile' } }, origin, false), false);
});
