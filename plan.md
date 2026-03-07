# Traefik fallback debugging plan

Goal: figure out why NetBird peer traffic to `ytdl.mink.lan:443` is still failing even though:

- Traefik is a normal pod
- the Traefik service is `NodePort`
- local Pi tests to the NodePort work
- `wt0` redirect rules exist

Current theory: the failure is happening at the Pi host edge, before traffic is successfully handed off to the NodePort path for real remote peer traffic.

## What to run on the Pi

Open one terminal on the Pi for packet capture, and another for the static state commands.

### 1) Show redirect table and NodePort rules

Run:

```bash
sudo nft list table inet traefik_wt0_redirect
sudo iptables-save | grep -E '32080|32443'
sudo nft list ruleset | grep -E '32080|32443'
```

Paste output here:

```text

```

### 2) Watch incoming traffic on `wt0`

Run this and leave it running while you test from another NetBird peer:

```bash
sudo tcpdump -ni wt0 'tcp port 443 or tcp port 32443'
```

Paste output here after you run the peer-side tests below:

```text

```

### 3) Optional: watch any interface for the same ports

If the `wt0` capture is inconclusive, also try:

```bash
sudo tcpdump -ni any 'tcp port 443 or tcp port 32443'
```

Paste output here:

```text

```

## What to run from another NetBird peer

While the Pi `tcpdump` is running, execute these:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'
```

Paste output here:

```text

```

## What I will determine from the outputs

These checks will tell us which of these is true:

- peer traffic reaches `wt0:443` but never gets redirected
- peer traffic is redirected to `32443` but the NodePort path still rejects it
- peer traffic reaches `32443` and then fails later in kube-proxy/service routing
- the issue is specific to `wt0` vs `any` interface handling

## Decision rule after this round

- If `443` packets appear on `wt0` but no `32443` packets appear, the redirect rule is not matching or not rewriting the way we expect.
- If `32443` packets appear and the peer still gets `Connection refused`, the NodePort path itself is not usable for remote NetBird traffic.
- If direct peer access to `100.90.167.160:32443` works but `443` does not, the redirect rule is the only remaining issue.

Once you paste the outputs, I can tell you whether to:

1. change the nft redirect rule shape again, or
2. stop targeting the NodePort and DNAT directly to the Traefik pod/service path instead
