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
