#!/usr/bin/env bash
set -euo pipefail

# One-command deploy for BSC testnet.
# Deploy order:
#   1) MockERC20("Mock USDT", "USDT", 18)
#   2) GroupBuyFactory(mockToken, admin, 18)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RPC_URL="${RPC_URL:-https://data-seed-prebsc-1-s1.bnbchain.org:8545}"
TOKEN_NAME="${TOKEN_NAME:-Mock USDT}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-USDT}"
TOKEN_DECIMALS="${TOKEN_DECIMALS:-18}"

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  echo "[ERROR] PRIVATE_KEY is required"
  exit 1
fi

if [[ -z "${ADMIN_ADDRESS:-}" ]]; then
  echo "[ERROR] ADMIN_ADDRESS is required"
  exit 1
fi

if [[ -z "${MERCHANT_ADDRESS:-}" ]]; then
  MERCHANT_ADDRESS="$ADMIN_ADDRESS"
fi

echo "[INFO] RPC_URL=$RPC_URL"
echo "[INFO] ADMIN_ADDRESS=$ADMIN_ADDRESS"
echo "[INFO] MERCHANT_ADDRESS=$MERCHANT_ADDRESS"

echo "[INFO] Checking chain id..."
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
if [[ "$CHAIN_ID" != "97" ]]; then
  echo "[ERROR] Expected BSC testnet chain id 97, got $CHAIN_ID"
  exit 1
fi

echo "[INFO] Deployer address: $(cast wallet address --private-key "$PRIVATE_KEY")"

extract_addr() {
  awk '/Deployed to:/{print $3}' | tail -n 1
}

echo "[STEP 1/2] Deploying MockERC20..."
MOCK_OUTPUT=$(forge create src/mocks/MockERC20.sol:MockERC20 \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "$TOKEN_NAME" "$TOKEN_SYMBOL" "$TOKEN_DECIMALS" 2>&1)

echo "$MOCK_OUTPUT"
MOCK_TOKEN_ADDRESS=$(echo "$MOCK_OUTPUT" | extract_addr)
if [[ -z "$MOCK_TOKEN_ADDRESS" ]]; then
  echo "[ERROR] Failed to parse MockERC20 address"
  exit 1
fi

echo "[STEP 2/2] Deploying GroupBuyFactory..."
FACTORY_OUTPUT=$(forge create src/GroupBuyFactory.sol:GroupBuyFactory \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "$MOCK_TOKEN_ADDRESS" "$ADMIN_ADDRESS" "$TOKEN_DECIMALS" 2>&1)

echo "$FACTORY_OUTPUT"
FACTORY_ADDRESS=$(echo "$FACTORY_OUTPUT" | extract_addr)
if [[ -z "$FACTORY_ADDRESS" ]]; then
  echo "[ERROR] Failed to parse GroupBuyFactory address"
  exit 1
fi

cat <<SUMMARY

================ Deployment Summary ================
Network: BSC Testnet (chainId=97)
MockERC20:      $MOCK_TOKEN_ADDRESS
GroupBuyFactory:$FACTORY_ADDRESS
Admin:          $ADMIN_ADDRESS
Merchant:       $MERCHANT_ADDRESS
====================================================

Next:
1) In web UI defaults, set Factory Address to: $FACTORY_ADDRESS
2) Set Token Address to: $MOCK_TOKEN_ADDRESS
3) Token symbol/decimals: $TOKEN_SYMBOL / $TOKEN_DECIMALS
4) Mint test token to users with MockERC20.mint(user, amount)
SUMMARY
