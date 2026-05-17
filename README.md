# Whacky Slot Account Service

Node backend for account, wallet, and future billing/user-management work for the frontend at `C:\Users\gilak\Pictures\imperium-reels`.

## Responsibilities

- expose the current demo user/account snapshot
- expose the current wallet balance
- accept wallet settlement updates from the frontend after locally resolved spins/features
- act as the backend integration point for future billing and user-management features

## Current API

- `GET /api/me`
- `GET /api/wallet`
- `POST /api/wallet/settle`
- `POST /api/refill-requests`
- `GET /api/refill-requests/:requestId?guestId=...`
- `POST /api/refill-requests/:requestId/claim`

## Guest Top-Up Flow

- the frontend generates a browser guest ID and sends a refill request to the backend
- open `http://localhost:3001/admin/refill-requests` to review pending requests
- click `Approve +2000` to allow that guest to refill locally
- the guest browser polls the request status and adds `2000` coins after the approved request is claimed

This first version keeps refill requests only in memory. Restarting the backend clears pending and approved requests.

## Run

```bash
cd C:\Users\gilak\Pictures\olympus-giggle-reels-backend
npm install
npm run dev
```
