# Whacky Slot Account Service

Node backend for guest coin play plus a new Postgres-backed user wallet flow for signed-in players.

## What It Does

- keeps the guest refill request flow for `2000` starting coins
- adds simple username/password sign-up and sign-in
- stores users, sessions, wallets, deposits, and ledger entries in Postgres
- gives signed-in users a manual TrueMoney deposit flow
- adds an admin page to approve or reject manual deposit requests

## Guest Flow

- guests still start with `2000` coins
- guests can create refill requests through `POST /api/refill-requests`
- open `http://localhost:3001/admin/refill-requests` to review guest refill requests
- approved guest refills still add `2000` coins after the guest claims the request

Guest refill requests are still in memory and reset when the backend restarts.

## Signed-In User Flow

- signed-in users register with `username` and `password`
- each new signed-in user gets a THB wallet with `0.00` balance
- the frontend can fetch deposit instructions from `GET /api/deposit-instructions`
- the frontend creates a pending deposit request with `POST /api/deposits`
- after the real transfer is received in your TrueMoney receiving account, approve it in `http://localhost:3001/admin/deposits`
- approval credits the signed-in user's THB wallet and writes a ledger entry

`POST /api/wallet/settle` now only works for guests. Signed-in THB balances are intentionally controlled by backend-approved deposit actions.

## Environment

Copy `.env.example` and set:

- `DATABASE_URL` for Postgres
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` for the deposit admin page
- `TRUEMONEY_RECIPIENT_NAME`
- `TRUEMONEY_RECIPIENT_ACCOUNT`
- optional `TRUEMONEY_RECIPIENT_NOTE`

The backend auto-creates the required Postgres tables on startup.

## Main API

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `POST /api/auth/signout`
- `GET /api/me`
- `GET /api/wallet`
- `GET /api/deposit-instructions`
- `GET /api/deposits`
- `POST /api/deposits`
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
