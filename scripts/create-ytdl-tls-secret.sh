#!/usr/bin/env bash

set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
HOSTNAME="${HOSTNAME:-ytdl.mink.lan}"
SECRET_NAME="${SECRET_NAME:-ytdl-tls}"
CERT_FILE="${CERT_FILE:-${HOSTNAME}.crt}"
KEY_FILE="${KEY_FILE:-${HOSTNAME}.key}"

openssl req -x509 -nodes -newkey rsa:4096 -days 825 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -subj "/CN=$HOSTNAME" \
  -addext "subjectAltName=DNS:$HOSTNAME"

kubectl -n "$NAMESPACE" create secret tls "$SECRET_NAME" \
  --cert="$CERT_FILE" \
  --key="$KEY_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

printf 'Created/updated secret %s in namespace %s\n' "$SECRET_NAME" "$NAMESPACE"
printf 'Trust certificate file on your client devices: %s\n' "$CERT_FILE"
