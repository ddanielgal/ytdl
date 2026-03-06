# Deployment and Networking Research

This document summarizes how this app appears to be deployed and exposed, based on the repository and live network checks from this host while connected to NetBird.

## Short answer

- The app is built as a Bun web server listening on port `3000` inside its container.
- It is deployed to Kubernetes with separate `app`, `worker`, and `redis` workloads.
- The intended public hostname is `ytdl.mink.lan`.
- Traffic is meant to enter through a Traefik `Ingress`, terminate TLS with the `ytdl-tls` secret, and forward to the `ytdl` service on port `80`, which targets container port `3000`.
- The repo and README strongly indicate the workload is hosted on a Raspberry Pi.
- NetBird DNS currently resolves `ytdl.mink.lan` to the Raspberry Pi peer's NetBird IP `100.90.167.160`.
- From this host, ICMP to that peer works, but TCP access to ports `80` and `443` times out, and direct access to `3000` is refused. So the hostname resolves correctly over NetBird, but the app is not currently reachable from this client.

## Repository evidence

### Hosting target

- `README.md:27` says: `I host this on my Raspberry Pi.`
- `README.md:36` builds for `--platform linux/arm64/v8`, which matches a 64-bit Raspberry Pi target.

### Runtime and serving model

The web app is a Bun server:

- `server.ts:21` starts `serve(...)`.
- `server.ts:22` listens on `process.env.PORT` or `3000` by default.
- `server.ts:24` serves the SPA entrypoint for `/`, `/queue`, and `/queue/`.
- `server.ts:34` handles the API under `/api/trpc`.

So the app itself is not relying on Nginx/Caddy inside the container; Bun is the HTTP server.

### Container image

- `Dockerfile:9` uses `oven/bun:1-slim`.
- `Dockerfile:35` exposes port `3000`.
- `Dockerfile:36` runs `bun run server.ts`.

The same image is reused for the background worker:

- `k8s/worker.yml:19` uses `pi.home:30500/ddanielgal/ytdl:latest`.
- `k8s/worker.yml:20` overrides the command to `bun run src/worker/worker.ts`.

### Kubernetes deployment shape

The current deployment is split into:

1. `ytdl` app deployment
2. `ytdl-worker` deployment
3. `redis` deployment

Relevant files:

- `k8s/app.yml`
- `k8s/worker.yml`
- `k8s/redis.yml`
- `k8s/pvc.yml`

## How the app is served

### App pod

`k8s/app.yml` defines:

- a `Deployment` named `ytdl`
- one container exposing `containerPort: 3000`

That matches the Bun server in `server.ts`.

### Service

`k8s/app.yml:37` defines a `Service` named `ytdl`:

- service port: `80`
- target port: `3000`

So inside Kubernetes, the app is accessed through the service on port `80`, which forwards to Bun on `3000`.

### Ingress

`k8s/app.yml:49` defines an `Ingress`:

- `ingressClassName: traefik`
- host: `ytdl.mink.lan`
- path: `/`
- backend service: `ytdl`
- backend service port: `80`

This means the intended request path is:

`client -> Traefik ingress -> ytdl service:80 -> app container:3000`

### TLS

The ingress also specifies TLS:

- host: `ytdl.mink.lan`
- secret: `ytdl-tls`

`scripts/create-ytdl-tls-secret.sh` creates a self-signed certificate for `ytdl.mink.lan` and uploads it as the `ytdl-tls` Kubernetes secret.

That script defaults to:

- `HOSTNAME=ytdl.mink.lan`
- `SECRET_NAME=ytdl-tls`

So the repo's intended HTTPS endpoint is clearly:

`https://ytdl.mink.lan/`

## Where it is hosted

The strongest evidence says it is hosted on a Raspberry Pi:

- `README.md:27`
- ARM64 image build target in `README.md:36`

The manifests do not explicitly say whether the Pi is:

- the only Kubernetes node,
- the ingress/front door for a small cluster,
- or simply the node running Traefik and the app.

But the repo strongly supports: this app is hosted on a Raspberry Pi-based home-lab Kubernetes setup.

## What domain it uses

The app has moved to host-based routing on `mink.lan`.

Evidence:

- `k8s/app.yml:57` and `k8s/app.yml:60` use `ytdl.mink.lan`
- `scripts/create-ytdl-tls-secret.sh:6` defaults the certificate hostname to `ytdl.mink.lan`
- recent git history includes `get rid of basepath, switch to mink.lan hosting`

That commit history indicates an earlier deployment probably used a subpath on another hostname, but the current repo is configured for direct host-based serving at `ytdl.mink.lan`.

## NetBird custom zone and hostname mapping

From this host, NetBird is connected and the peer for the Raspberry Pi is reachable.

### NetBird status from this host

`netbird status` reported:

- local NetBird IP: `100.90.149.44/16`
- local FQDN: `battlestation.mink.danielgal.eu`
- peer connected: `pi.mink.danielgal.eu`

`netbird status -d` reported for the Pi peer:

- peer name: `pi.mink.danielgal.eu`
- peer NetBird IP: `100.90.167.160`
- status: `Connected`
- connection type: `P2P`
- latency: about `1.1 ms`

### DNS resolution

From this host:

- `getent ahosts ytdl.mink.lan` returned `100.90.167.160`
- `resolvectl query ytdl.mink.lan` returned `100.90.167.160` on link `wt0`
- `resolvectl query pi.mink.danielgal.eu` also returned `100.90.167.160`

That is the key confirmation for the NetBird custom zone setup:

- custom zone: `mink.lan`
- app hostname: `ytdl.mink.lan`
- resolved target: Raspberry Pi NetBird IP `100.90.167.160`

In practice, `ytdl.mink.lan` is currently mapped to the Pi's NetBird address.

## Network diagnostics from this host

I used the host's network tools while connected to NetBird.

### Reachability that works

`ping -c 3 ytdl.mink.lan`

Result:

- resolved to `100.90.167.160`
- replies came back from `pi.mink.danielgal.eu`
- RTT was about `0.7-1.1 ms`

This confirms basic peer-to-peer connectivity to the Raspberry Pi over NetBird.

### Ports tested

`nc -vz -w 3 ytdl.mink.lan 80 443 3000`

Results:

- port `80`: timed out
- port `443`: timed out
- port `3000`: connection refused

Interpretation:

- `3000` being refused suggests nothing is listening on the Pi's NetBird interface directly on that port, or the process only listens behind Kubernetes/cluster networking.
- `80` and `443` timing out suggests a firewall, missing bind on the NetBird interface, ingress not exposed on the NetBird path, or routing/NAT that does not accept these connections from the overlay.

### HTTP/HTTPS checks

These requests all failed from this host:

- `curl http://ytdl.mink.lan/` -> timeout
- `curl https://ytdl.mink.lan/` -> timeout
- `curl http://100.90.167.160:3000/` -> connection refused
- `curl -H "Host: ytdl.mink.lan" http://100.90.167.160/` -> timeout
- `curl --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/` -> timeout

So I could not actually retrieve the app over NetBird from this host.

## TLS certificate findings

There are two separate TLS-related signals in the repo:

1. The active Kubernetes intent:
   - `scripts/create-ytdl-tls-secret.sh` generates a certificate specifically for `ytdl.mink.lan`
   - `k8s/app.yml` expects that cert in secret `ytdl-tls`

2. The checked-in file `pi.crt`:
   - subject: `CN=pi`
   - SAN: `DNS:pi`

That checked-in `pi.crt` does not match `ytdl.mink.lan`, so it does not appear to be the intended cert for the current ingress hostname. It is likely older, unrelated, or used for another local endpoint.

I could not inspect the live certificate presented on `ytdl.mink.lan:443` because the TCP connection never completed.

## Best reconstruction of the deployment

The current intended topology appears to be:

1. A Raspberry Pi hosts the app environment.
2. Kubernetes runs `ytdl`, `ytdl-worker`, and `redis`.
3. Bun serves the web app in the app pod on port `3000`.
4. A Kubernetes `Service` exposes that pod internally on port `80`.
5. Traefik ingress routes `ytdl.mink.lan` to that service.
6. TLS is supposed to be terminated by Traefik using the `ytdl-tls` secret.
7. NetBird custom DNS for `mink.lan` maps `ytdl.mink.lan` to the Raspberry Pi's NetBird IP `100.90.167.160`.

## What is working vs not working right now

### Working

- NetBird is connected on this host.
- The Raspberry Pi peer is connected over NetBird.
- DNS for `ytdl.mink.lan` resolves to the Pi's NetBird IP.
- ICMP reachability to that peer works.

### Not working from this host

- TCP access to `80/tcp` and `443/tcp` on `ytdl.mink.lan`
- direct TCP access to `3000/tcp` on `100.90.167.160`
- HTTP and HTTPS retrieval of the app

## Most likely explanations for the access failure

Based on the repo plus diagnostics, the most likely causes are:

1. Traefik or the Kubernetes ingress is not bound to the Raspberry Pi's NetBird interface.
2. A firewall on the Pi or cluster blocks NetBird-originated TCP to `80/443`.
3. The app/ingress is only exposed on LAN addresses and not on the NetBird overlay address.
4. `ytdl.mink.lan` correctly resolves to the Pi's NetBird IP, but no listener on that IP is actually serving the ingress.
5. The deployment may not currently be running even though DNS is in place.

## Bottom line

The repo shows a clear intended deployment: Bun app on Kubernetes, fronted by Traefik, served at `https://ytdl.mink.lan/`, hosted on a Raspberry Pi, with `ytdl.mink.lan` mapped through a NetBird custom zone to the Pi's NetBird IP `100.90.167.160`.

From this host, the NetBird side of name resolution and peer connectivity is working, but the application itself is not reachable over TCP/HTTP(S). The deployment and DNS configuration appear aligned, but service exposure on the Pi's NetBird path is currently not functioning.
