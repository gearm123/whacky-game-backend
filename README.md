# Whacky Slot Account Service

Node backend for guest coin play plus a Postgres-backed username/password system for signed-in players.

## What It Does

- keeps the guest refill request flow for `2000` starting coins
- adds simple username/password sign-up and sign-in
- stores users, sessions, signed-in wallets, and ledger entries in Postgres
- keeps signed-in user balances separate from guest demo coins
- adds an admin page to add coins or set an exact signed-in user balance

## Guest Flow

- guests still start with `2000` coins
- guests can create refill requests through `POST /api/refill-requests`
- open `http://localhost:3001/admin/refill-requests` to review guest refill requests
- approved guest refills still add `2000` coins after the guest claims the request

Guest refill requests are still in memory and reset when the backend restarts.

## Signed-In User Flow

- signed-in users register with `username` and `password`
- each new signed-in user gets a `USER_COINS` wallet with `0.00` balance
- signed-in balances are stored in Postgres
- signed-in balances can only be changed from the admin panel
- open `http://localhost:3001/admin/users` to add coins or set a user's exact balance
- every admin change writes a ledger entry for that user

`POST /api/wallet/settle` now only works for guests. Signed-in balances are intentionally controlled by the admin panel.

## Environment

Copy `.env.example` and set:

- `DATABASE_URL` for Postgres
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` for the admin pages

The backend auto-creates the required Postgres tables on startup.

## Main API

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `POST /api/auth/signout`
- `GET /api/me`
- `GET /api/wallet`
- `POST /api/refill-requests`
- `GET /api/refill-requests/:requestId?guestId=...`
- `POST /api/refill-requests/:requestId/claim`
- `POST /api/wallet/settle`

## Run

```bash
cd C:\Users\gilak\Pictures\olympus-giggle-reels-backend
npm install
npm run dev
```
