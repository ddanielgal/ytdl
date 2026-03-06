# Plan: Make `ytdl.mink.lan` Reachable Over NetBird

## Goal

Make `https://ytdl.mink.lan/` work for NetBird peers by sending traffic to the Raspberry Pi's NetBird IP and terminating it in the Pi's single-node k3s cluster.

## Recommended path

The easiest path on a single-node Raspberry Pi k3s setup is:

1. keep the existing Kubernetes `Ingress` for `ytdl.mink.lan`
2. keep NetBird DNS pointing `ytdl.mink.lan` to the Pi's NetBird IP
3. make Traefik listen directly on the Pi host network for `80/443`
4. allow inbound NetBird traffic on interface `wt0` to `80/443`

This is simpler than adding MetalLB, extra proxies, or multi-node load balancer plumbing. On a single node, the Pi itself is the edge.

## Why this is probably failing now

Current evidence says:

- NetBird DNS works: `ytdl.mink.lan -> 100.90.167.160`
- peer reachability works: `ping` succeeds
- app reachability fails: `80/443` time out and `3000` is refused

That points to an edge exposure problem, not a DNS problem. The most likely issues are:

- Traefik is not actually reachable on the Pi's NetBird interface
- k3s ServiceLB/iptables is not exposing `80/443` on `wt0`
- the Pi firewall is dropping overlay traffic from NetBird peers

## Plan

### 1. Verify the app works inside k3s first

On the Pi, confirm the app, service, and ingress are healthy.

Checks:

- `kubectl get pods -A -o wide`
- `kubectl get svc -A`
- `kubectl get ingress -A`
- `kubectl describe ingress ytdl`
- `kubectl get endpoints ytdl`

Success looks like:

- `ytdl` pod is `Running`
- `ytdl-worker` is `Running`
- `redis` is `Running`
- service `ytdl` has endpoints
- ingress `ytdl` is admitted by Traefik

If this is broken, fix it before touching NetBird.

### 2. Confirm Traefik is the real entrypoint

On the Pi, check the Traefik deployment and whether anything listens on host ports `80/443`.

Checks:

- `kubectl -n kube-system get pods,svc | grep traefik`
- `sudo ss -ltnp | grep -E ':(80|443)\s'`

What you want:

- Traefik healthy in `kube-system`
- a listener on the Pi for `:80` and `:443`

If nothing is listening on host `80/443`, NetBird peers will resolve the name correctly but never reach the app.

### 3. Simplify the edge: put Traefik on the host network

Recommended fix for a single-node Pi cluster:

- configure Traefik to use `hostNetwork: true`
- let Traefik bind directly to the Pi on `80/443`
- continue using the existing `Ingress` for host routing and TLS

Why this is the easiest path:

- no extra load balancer needed
- no MetalLB setup
- no separate reverse proxy outside k3s
- no dependence on ServiceLB behavior over the NetBird interface

Tradeoff:

- nothing else on the Pi can use `80/443`

Implementation note:

- for packaged k3s Traefik, use a `HelmChartConfig` override rather than editing generated resources by hand
- place the override in `/var/lib/rancher/k3s/server/manifests/`

Suggested change direction:

- enable Traefik `hostNetwork`
- ensure the deployment has one replica on the Pi node
- keep entrypoints on `web` `:80` and `websecure` `:443`

### 4. Open the Pi firewall for NetBird traffic

Even if Traefik is listening, firewall rules can still cause the exact timeout behavior you saw.

Allow inbound traffic from NetBird peers to the Pi on interface `wt0` for:

- `tcp/80`
- `tcp/443`

Check for:

- `ufw`
- `nftables`
- raw iptables rules

Typical intent:

- allow `wt0 -> local :80`
- allow `wt0 -> local :443`

If you want to be stricter, allow only the NetBird address range instead of all sources.

### 5. Keep the app ingress exactly as it is

Your current app manifest is already the right shape for host-based access:

- host `ytdl.mink.lan`
- path `/`
- service `ytdl:80`
- TLS secret `ytdl-tls`

So the app-side Kubernetes config should mostly stay unchanged.

### 6. Recreate the TLS secret for the real hostname

Use the existing script to generate a cert for `ytdl.mink.lan`:

- `scripts/create-ytdl-tls-secret.sh`

Important:

- the old checked-in `pi.crt` is for `pi`, not `ytdl.mink.lan`
- clients must trust the generated cert if you keep it self-signed

If you want the lowest-friction private setup, keep the self-signed cert and trust it on the devices that use NetBird.

### 7. Test locally on the Pi before testing from another peer

Before blaming NetBird, validate on the Pi itself.

Tests on the Pi:

- `curl -vk -H 'Host: ytdl.mink.lan' https://127.0.0.1/`
- `curl -v -H 'Host: ytdl.mink.lan' http://127.0.0.1/`
- `curl -vk --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/`

Success means:

- Traefik accepts the request
- the host header matches the ingress rule
- the app responds through the full chain

### 8. Then test from a second NetBird peer

From another connected device:

- `getent ahosts ytdl.mink.lan`
- `nc -vz ytdl.mink.lan 80 443`
- `curl -vk https://ytdl.mink.lan/`

Expected result:

- DNS resolves to the Pi's NetBird IP
- `443` connects
- HTTPS returns the app

## If `hostNetwork` Traefik is too annoying

Fallback option:

- expose the `ytdl` app as a `NodePort`
- run a tiny reverse proxy on the Pi outside k3s, bound to `wt0:80/443`
- proxy `ytdl.mink.lan` to the NodePort

This also works, but it adds another moving part. For a single-node k3s Pi, direct host-networked Traefik is usually cleaner.

## What not to do first

Avoid these unless the simpler approach fails:

- adding MetalLB
- changing NetBird DNS away from the Pi IP
- exposing Bun directly on `3000`
- replacing Traefik with another ingress controller

Those add complexity without solving the most likely problem.

## Concrete order of operations

1. Verify `ytdl`, `redis`, and Traefik are healthy in k3s.
2. Check whether the Pi is actually listening on `80/443`.
3. Move Traefik to `hostNetwork: true` if it is not directly reachable on the host.
4. Allow inbound `wt0` traffic to `80/443` in the Pi firewall.
5. Recreate and trust the `ytdl.mink.lan` TLS cert.
6. Test on the Pi.
7. Test from another NetBird peer.

## Success criteria

The setup is done when all of these are true:

- `ytdl.mink.lan` resolves to the Pi's NetBird IP
- the Pi accepts TCP on `80/443` via `wt0`
- Traefik matches the `ytdl.mink.lan` ingress rule
- `curl -vk https://ytdl.mink.lan/` works from another NetBird peer
- the certificate presented is valid for `ytdl.mink.lan`

## Bottom line

For a single-node k3s Raspberry Pi, the simplest fix is to make the Pi itself the NetBird-facing edge: bind Traefik directly on the host network, allow `wt0` inbound `80/443`, and keep the existing `Ingress` and `ytdl.mink.lan` DNS mapping. That preserves the current Kubernetes design while removing the layer most likely blocking NetBird access.
