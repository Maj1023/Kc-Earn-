'use strict';

const bcrypt = require('bcryptjs');
const os = require('node:os');

const ADMIN_ROLE_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(1296389188, 1)';

function validateRoleChange(
  actorId,
  actorRole,
  targetId,
  oldRole,
  newRole,
  adminCount
) {
  if (actorRole !== 'admin') {
    return 'Administrator access required.';
  }

  if (!['user', 'admin'].includes(oldRole) ||
      !['user', 'admin'].includes(newRole)) {
    return 'Invalid administrator role.';
  }

  if (oldRole === newRole) {
    return 'The target already has that role.';
  }

  if (String(actorId) === String(targetId)) {
    return 'Administrators cannot change their own role.';
  }

  const parsedAdminCount = Number(adminCount);

  if (oldRole === 'admin' && newRole === 'user' &&
      (!Number.isFinite(parsedAdminCount) || parsedAdminCount <= 1)) {
    return 'The final administrator cannot be demoted.';
  }

  return null;
}

function getAdminAuthorizationError(user) {
  if (!user) {
    return { status: 401, error: 'Please log in first.' };
  }

  if (user.role !== 'admin') {
    return { status: 403, error: 'Administrator access required.' };
  }

  return null;
}

function isSessionActive(expiresAt, now = Date.now()) {
  const expiration = expiresAt instanceof Date
    ? expiresAt.getTime()
    : typeof expiresAt === 'string'
      ? Date.parse(expiresAt)
      : Number.NaN;

  return Number.isFinite(expiration) && expiration > now;
}

async function verifyCurrentPassword(passwordHash, password) {
  if (typeof password !== 'string' || password.length === 0 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      typeof passwordHash !== 'string' || passwordHash.length === 0) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}

async function createSessionRecord(pool, { userId, tokenHash, expiresAt }) {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rowCount !== 1) {
      throw new Error('Cannot create a session for a missing account.');
    }

    await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, userId, expiresAt]
    );

    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw new Error(
          'Session creation failed and rollback could not be confirmed.'
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function provisionAdministrator(pool, { email, reason }) {
  const normalizedEmail = typeof email === 'string'
    ? email.trim().toLowerCase()
    : '';
  const auditReason = typeof reason === 'string'
    ? reason.trim()
    : '';

  if (normalizedEmail.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('A valid administrator email address is required.');
  }

  if (auditReason.length < 1 || auditReason.length > 255) {
    throw new Error('A reason between 1 and 255 characters is required.');
  }

  let operator;
  try {
    operator = os.userInfo();
  } catch {
    throw new Error('Unable to determine a valid provisioning operator identity.');
  }

  if (!Number.isSafeInteger(operator.uid) ||
      operator.uid < 0 ||
      typeof operator.username !== 'string' ||
      operator.username.trim().length === 0) {
    throw new Error('Unable to determine a valid provisioning operator identity.');
  }

  const operatorIdentity =
    `uid:${operator.uid};username:${operator.username}`;
  if (operatorIdentity.length > 100) {
    throw new Error('Unable to determine a valid provisioning operator identity.');
  }

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    await client.query(ADMIN_ROLE_LOCK_SQL);

    const targetResult = await client.query(
      'SELECT id, role FROM users WHERE lower(email) = $1 FOR UPDATE',
      [normalizedEmail]
    );

    if (targetResult.rowCount !== 1) {
      throw new Error(
        targetResult.rowCount === 0
          ? 'No matching account was found.'
          : 'Multiple accounts match that email; provisioning was stopped.'
      );
    }

    const target = targetResult.rows[0];

    if (target.role === 'admin') {
      await client.query('COMMIT');
      committed = true;
      return { changed: false, userId: target.id };
    }

    if (target.role !== 'user') {
      throw new Error('The target account has an unsupported role.');
    }

    await client.query(
      "UPDATE users SET role = 'admin' WHERE id = $1",
      [target.id]
    );

    await client.query(
      'DELETE FROM sessions WHERE user_id = $1',
      [target.id]
    );

    await client.query(
      `INSERT INTO admin_provisioning_audit
       (target_user_id, operator_label, old_role, new_role, reason)
       VALUES ($1, $2, 'user', 'admin', $3)`,
      [target.id, operatorIdentity, auditReason]
    );

    await client.query('COMMIT');
    committed = true;

    return { changed: true, userId: target.id };
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw new Error(
          'Administrator provisioning failed and rollback could not be confirmed.'
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function isValidSessionToken(token) {
  return typeof token === 'string' &&
    /^[a-f0-9]{64}$/.test(token);
}

module.exports = {
  ADMIN_ROLE_LOCK_SQL,
  createSessionRecord,
  getAdminAuthorizationError,
  isSessionActive,
  provisionAdministrator,
  validateRoleChange,
  verifyCurrentPassword,
  isValidSessionToken
};
