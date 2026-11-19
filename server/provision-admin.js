'use strict';

const { Pool } = require('pg');
const { provisionAdministrator } = require('./admin-security');

function parseArguments(argv) {
  const options = new Map();
  const allowedOptions = new Set([
    '--email',
    '--reason',
    '--confirm-email'
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];

    if (!allowedOptions.has(option) || !value || options.has(option)) {
      throw new Error(
        'Use --email, --reason and --confirm-email exactly once.'
      );
    }

    options.set(option, value);
  }

  if (options.size !== allowedOptions.size) {
    throw new Error(
      'Use --email, --reason and --confirm-email exactly once.'
    );
  }

  const email = options.get('--email').trim().toLowerCase();
  const confirmation = options.get('--confirm-email').trim().toLowerCase();

  if (email !== confirmation) {
    throw new Error('The confirmation email does not match.');
  }

  return {
    email,
    reason: options.get('--reason')
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured for this operation.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true
  });

  try {
    const result = await provisionAdministrator(pool, options);
    console.log(result.changed
      ? 'Administrator access provisioned and recorded.'
      : 'The account already has administrator access; no change made.');
  } finally {
    await pool.end();
  }
}

const SAFE_ERRORS = new Set([
  'Use --email, --reason and --confirm-email exactly once.',
  'The confirmation email does not match.',
  'DATABASE_URL must be configured for this operation.',
  'A valid administrator email address is required.',
  'Unable to determine a valid provisioning operator identity.',
  'A reason between 1 and 255 characters is required.',
  'No matching account was found.',
  'Multiple accounts match that email; provisioning was stopped.',
  'The target account has an unsupported role.',
  'Administrator provisioning failed and rollback could not be confirmed.'
]);

main().catch(error => {
  console.error(SAFE_ERRORS.has(error.message)
    ? 'Administrator provisioning failed: ' + error.message
    : 'Administrator provisioning failed; inspect database state before retrying.');
  process.exitCode = 1;
});
