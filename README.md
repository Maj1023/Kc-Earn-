# KC Earn

KC Earn is a mobile rewards platform with customer accounts, a rewards wallet, transaction history, withdrawal requests, an administrative dashboard, and Offerzy postback processing.

## Mobile app setup

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env`.
3. The app defaults to the deployed API at `https://kc-earn.onrender.com`. To override it for another environment, set `EXPO_PUBLIC_API_URL` to the public HTTPS base URL without a trailing slash or an `/api` suffix.
4. Start the Expo app with `npm start`.

The mobile app uses the existing backend endpoints for registration, login, the signed-in customer profile, wallet balance, and wallet transactions. Mobile session tokens are stored with Expo SecureStore and sent as bearer tokens. The backend continues to enforce matching Origin headers for browser POST requests; native requests use the explicit mobile client header for registration/login and bearer authentication for later POST requests.

**Deployment note:** the backend changes in this branch must be deployed to the API host before mobile registration and login will work. The API host must already have its production database configured with `DATABASE_URL` and the other required server environment variables. Never put database credentials, Offerzy secrets, or other private keys in `EXPO_PUBLIC_*` variables.

## Checks

- `npm test` runs the Node.js automated tests.
- `npm run typecheck` checks the TypeScript mobile app.
- GitHub Actions runs both checks for feature branch pushes and pull requests to `main`.

## Earnings integrity

Wallet balances and transaction history are read from the backend ledger. The mobile interface does not create or simulate earnings. Only verified provider callbacks and authorized backend operations should credit customer wallets.
