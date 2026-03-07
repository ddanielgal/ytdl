#!/usr/bin/env bash

set -euo pipefail

WT0_IP="${WT0_IP:-${1:-}}"
TRAEFIK_NAMESPACE="${TRAEFIK_NAMESPACE:-kube-system}"
TRAEFIK_SELECTOR="${TRAEFIK_SELECTOR:-app.kubernetes.io/name=traefik}"
TABLE_NAME="${TABLE_NAME:-ytdl_wt0_dnat}"
RULE_TAG="${RULE_TAG:-ytdl-netbird-traefik}"

NFT_BIN="$(command -v nft || true)"
AWK_BIN="$(command -v awk || true)"
K3S_BIN="$(command -v k3s || true)"
KUBECTL_BIN="$(command -v kubectl || true)"

if [ -z "$WT0_IP" ]; then
  echo "Set WT0_IP or pass it as the first argument" >&2
  exit 1
fi

if [ -z "$NFT_BIN" ] || [ -z "$AWK_BIN" ]; then
  echo "Missing required commands: nft and/or awk" >&2
  exit 1
fi

if [ -n "$K3S_BIN" ]; then
  KUBECTL_CMD=("$K3S_BIN" kubectl)
elif [ -n "$KUBECTL_BIN" ]; then
  KUBECTL_CMD=("$KUBECTL_BIN")
else
  echo "Missing required command: k3s or kubectl" >&2
  exit 1
fi

if ! "$NFT_BIN" list chain ip netbird netbird-rt-fwd >/dev/null 2>&1; then
  echo "NetBird nftables chain ip/netbird/netbird-rt-fwd not found" >&2
  exit 1
fi

TRAEFIK_POD_IP="$("${KUBECTL_CMD[@]}" -n "$TRAEFIK_NAMESPACE" get pods -l "$TRAEFIK_SELECTOR" -o jsonpath='{range .items[*]}{.status.phase}{" "}{.status.podIP}{"\n"}{end}' 2>/dev/null | "$AWK_BIN" '$1=="Running" && $2 != "" { print $2; exit }')"

if [ -z "$TRAEFIK_POD_IP" ]; then
  echo "Could not determine a running Traefik pod IP" >&2
  exit 1
fi

"$NFT_BIN" delete table inet "$TABLE_NAME" 2>/dev/null || true
"$NFT_BIN" add table inet "$TABLE_NAME"
"$NFT_BIN" "add chain inet $TABLE_NAME prerouting { type nat hook prerouting priority -101; policy accept; }"
"$NFT_BIN" "add chain inet $TABLE_NAME postrouting { type nat hook postrouting priority srcnat; policy accept; }"

"$NFT_BIN" add rule inet "$TABLE_NAME" prerouting iifname "wt0" ip daddr "$WT0_IP" tcp dport 80 counter dnat to "$TRAEFIK_POD_IP":8000 comment "$RULE_TAG"
"$NFT_BIN" add rule inet "$TABLE_NAME" prerouting iifname "wt0" ip daddr "$WT0_IP" tcp dport 443 counter dnat to "$TRAEFIK_POD_IP":8443 comment "$RULE_TAG"
"$NFT_BIN" add rule inet "$TABLE_NAME" postrouting oifname "cni0" ip daddr "$TRAEFIK_POD_IP" tcp dport 8000 counter masquerade comment "$RULE_TAG"
"$NFT_BIN" add rule inet "$TABLE_NAME" postrouting oifname "cni0" ip daddr "$TRAEFIK_POD_IP" tcp dport 8443 counter masquerade comment "$RULE_TAG"

for handle in $("$NFT_BIN" -a list chain ip netbird netbird-rt-fwd | "$AWK_BIN" -v tag="$RULE_TAG" '$0 ~ tag { print $NF }'); do
  "$NFT_BIN" delete rule ip netbird netbird-rt-fwd handle "$handle"
done

"$NFT_BIN" add rule ip netbird netbird-rt-fwd ip daddr "$TRAEFIK_POD_IP" tcp dport 8000 counter accept comment "$RULE_TAG"
"$NFT_BIN" add rule ip netbird netbird-rt-fwd ip daddr "$TRAEFIK_POD_IP" tcp dport 8443 counter accept comment "$RULE_TAG"

echo "Reconciled NetBird -> Traefik forwarding for WT0_IP=$WT0_IP TRAEFIK_POD_IP=$TRAEFIK_POD_IP"
