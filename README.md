# Kc-Earn-
A mobile rewards platform where users can earn through paid surveys, offerwalls, app offers, online tasks and referrals. Includes user accounts, rewards wallet, transaction history, withdrawal requests and an administrative dashboard.

## Administrator provisioning

Application startup does not promote accounts based on `ADMIN_EMAIL`. Existing
administrator roles stored in the database are left unchanged, and ordinary
registration always creates a `user` role. Administrator role changes made
through the application require an administrator session and current-password
verification and are recorded in the role audit table.

To explicitly provision an existing account, the owner must first verify the
exact account email and approve the action. After deploying this version and
confirming its startup has completed, run the following command in an approved
environment with the application's `DATABASE_URL` and `DATABASE_SSL` settings:

```sh
node server/provision-admin.js \
  --email '<verified account email>' \
  --reason '<provisioning reason>' \
  --confirm-email '<same verified account email>'
```

The command only promotes the matching account; it never demotes another
administrator. The action is recorded separately in
`admin_provisioning_audit`, with the operator recorded from the operating
system username and UID running the command. In environments where operators
share a service account, this identifies that account rather than an individual.
Do not run it until the owner has confirmed the target account and authorized
the provisioning.

## Offerwall.GG (secondary offer provider)

Offerzy remains the primary provider. Offerwall.GG is available as a separate
secondary tile and uses its hosted wall; its public key and signature are
handled by the backend access route. Keep `OFFERWALL_GG_SECRET_KEY` server-side
and never place it in `public/index.html`, mobile code, or a client bundle.

Provider reference: [integration guide](https://offerwall.gg/developers/quickstart)
and [conversion postback contract](https://offerwall.gg/developers/postbacks).

Configure these server environment variables from the Offerwall.GG placement:

- `OFFERWALL_GG_PUBLIC_KEY`: placement public key (32 characters).
- `OFFERWALL_GG_SECRET_KEY`: placement secret key.
- `OFFERWALL_GG_UNITS_PER_USD`: the exact `currency.perUsd` value returned by
  the provider for that placement. Do not assume it is `1000`.
- `OFFERWALL_GG_SIGNED_LINK_EXPIRY_ENABLED`: optional; set to `true` only when
  expiring signed links are enabled for the placement, otherwise leave unset or
  set to `false`.

In the placement callback settings, use
`https://<your-app-host>/api/offerwall-gg/postback` with no macros so the
provider appends its documented callback fields. GET callbacks and
`application/x-www-form-urlencoded` POST callbacks are supported. Enable
signature-required links on the placement; if its signed-link expiry option is
enabled, also set `OFFERWALL_GG_SIGNED_LINK_EXPIRY_ENABLED=true`.

Offerwall.GG documents `currencyAmount` as the placement currency amount,
equal to its USD payout multiplied by the placement's `currency.perUsd` rate.
The callback signature covers `userId:transactionId:currencyAmount`, but does
not cover `payoutUsd`; KC Earn therefore never uses `payoutUsd` to determine a
wallet credit. The backend divides the signed `currencyAmount` by the exact
configured placement units-per-USD value to derive provider USD revenue, then
uses the existing admin reward percentage and USD-to-NGN exchange rate to
calculate whole kobo. The calculation rounds down and records the settings
used for each credited conversion. If the units-per-USD value is missing or
invalid, no wallet credit is processed.

The existing global reward-enabled switch controls Offerwall.GG access and
credits. Test callbacks are acknowledged without a credit. Reversals debit the
originally recorded reward; any shortfall is tracked in the separate
Offerwall.GG recovery account, repaid from future Offerwall.GG rewards, and
blocks new withdrawal requests until cleared. Existing Offerzy postback and
recovery handling are not changed. The additive Offerwall.GG tables are
created by the server's existing database initialization routine.
