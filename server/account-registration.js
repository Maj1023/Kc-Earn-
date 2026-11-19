'use strict';

async function insertRegisteredUser(pool, { fullName, email, passwordHash }) {
  return pool.query(
    `INSERT INTO users (full_name, email, password_hash, role)
     VALUES ($1, $2, $3, 'user')
     RETURNING id, full_name, email, role, created_at`,
    [fullName, email, passwordHash]
  );
}

module.exports = { insertRegisteredUser };
