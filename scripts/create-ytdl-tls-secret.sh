#!/usr/bin/env bash

set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
HOSTNAME="${HOSTNAME:-ytdl.mink.lan}"
SECRET_NAME="${SECRET_NAME:-ytdl-tls}"
CERT_FILE="${CERT_FILE:-${HOSTNAME}.crt}"
KEY_FILE="${KEY_FILE:-${HOSTNAME}.key}"

K3S_BIN="$(command -v k3s || true)"
KUBECTL_BIN="$(command -v kubectl || true)"

if [ -n "$KUBECTL_BIN" ]; then
  KUBECTL_CMD=("$KUBECTL_BIN")
elif [ -n "$K3S_BIN" ]; then
  KUBECTL_CMD=("$K3S_BIN" kubectl)
else
  echo "Missing required command: kubectl or k3s" >&2
  exit 1
fi

openssl req -x509 -nodes -newkey rsa:4096 -days 825 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -subj "/CN=$HOSTNAME" \
  -addext "subjectAltName=DNS:$HOSTNAME"

"${KUBECTL_CMD[@]}" -n "$NAMESPACE" create secret tls "$SECRET_NAME" \
  --cert="$CERT_FILE" \
  --key="$KEY_FILE" \
  --dry-run=client -o yaml | "${KUBECTL_CMD[@]}" apply -f -

printf 'Created/updated secret %s in namespace %s\n' "$SECRET_NAME" "$NAMESPACE"
printf 'Trust certificate file on your client devices: %s\n' "$CERT_FILE"
