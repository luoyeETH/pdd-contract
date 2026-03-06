# Dynamic Cost-Sharing: Contracts + Web Portal

This repository includes:

- Solidity contracts for dynamic cost-sharing group-buy rounds.
- A lightweight web portal (admin + user) to operate preheat registration and on-chain actions.

## 1) Contracts

- `src/GroupBuyFactory.sol`
- `src/DynamicCostSharingRound.sol`

### Core behavior

- Fixed `totalCost` per round.
- Dynamic pricing: more participants -> lower unit cost.
- Pull refund model: users can claim surplus via `claimRefund`.
- Atomic seed creation: `createRoundWithSeed` pulls seed funds in one transaction.
- Seed amounts are constrained to near-even split at creation time:
  each seed must be `floor(totalCost / seedCount)` or `ceil(totalCost / seedCount)` (difference <= 1 minimal unit).
- Supports starting with **zero seed users** (empty arrays), so a campaign can start directly without preheat users.
- Admin can batch refund surplus after success: `batchRefundSurplus`.
- Merchant pulls payout after success: `withdrawMerchant`.

### Security controls

- `nonReentrant` on token-moving methods.
- Safe ERC20 calls + exact-transfer-in checks.
- Join race protection (`expectedCount` + `maxQuote`).
- EOA-only restrictions (`msg.sender == tx.origin`) on key external methods.
- Backend write APIs require wallet signature verification (`cast wallet verify`) with nonce + timestamp anti-replay.
- Backend write path is serialized with an in-process lock to avoid JSON file concurrent overwrite races.

### Important compatibility caveat

Because of EOA-only restrictions, this system does **not** support:

- Safe multisig wallets
- ERC-4337 smart accounts
- Contract wallet relayers/proxies

## 2) Web Portal

- Frontend: `web/index.html`, `web/app.js`, `web/styles.css`
- Backend API/static server: `web/server.mjs`
- Local storage for campaigns: `web-data/campaigns.json`

The web app supports:

1. Admin creates a preheat campaign (metadata + on-chain config).
2. Users approve USDT to factory and register demand in UI.
3. Registration count and estimated deduction update in UI.
4. Admin creates on-chain round (seed pull in same tx).
5. Users can join on-chain directly after round creation.
6. Users can view paid/claimed/refundable and claim manually.
7. Admin can run finalize and batch surplus refund actions.
8. Merchant can withdraw after success.

## 3) Run

### Contracts tests

```bash
forge test
```

### Web portal

```bash
node web/server.mjs
```

Then open:

- `http://localhost:3000`

## 4) Suggested operation flow

1. Deploy `GroupBuyFactory` on BSC with USDT address and expected decimals.
2. In web defaults, set factory/token addresses and token decimals.
3. Admin creates a campaign.
4. Users click `Approve + Register`.
5. Admin clicks `Admin Create On-Chain Round`.
6. Users click `Join On-Chain` / `Claim Refund` as needed.
7. Admin finalizes success/failure according to round conditions.
8. Merchant uses `Merchant Withdraw` after success.

## 5) Notes

- The backend is intentionally lightweight and file-backed (`web-data/campaigns.json`), not a replacement for a production DB.
- Write APIs now require client wallet signatures. Ensure Foundry `cast` is available on the backend host.
- Optional env vars:
  - `AUTH_MAX_SKEW_SECONDS` (default `300`)
  - `AUTH_NONCE_TTL_SECONDS` (default `900`)
  - `MAX_REGISTRATIONS_PER_CAMPAIGN` (default `5000`)
- Keep approvals scoped (avoid unnecessary unlimited allowance for users).
