'use strict';

function isMobileClient(req) {
  return req.headers['x-kc-client'] === 'mobile' && !req.headers.origin;
}

function isAllowedApiPost(req, expectedOrigin, allowMobileLogin = false) {
  const origin = req.headers.origin;

  if (origin) {
    try {
      return Boolean(
        expectedOrigin &&
        new URL(origin).origin === new URL(expectedOrigin).origin
      );
    } catch {
      return false;
    }
  }

  const authorization = req.headers.authorization || '';
  const hasBearerToken = /^Bearer [a-f0-9]{64}$/.test(authorization);
  return hasBearerToken || (allowMobileLogin && isMobileClient(req));
}

module.exports = { isMobileClient, isAllowedApiPost };
