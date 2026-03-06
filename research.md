# Deployment Research

This document describes how the app in this repository appears to be deployed based on the repository contents alone. Where something is not explicitly defined in the repo, it is called out as an inference.

## Executive take

- The app is intended to run on a Raspberry Pi and be reachable on the home network at `http://pi.home/ytdl`.
- The current deployment model in the repo is Kubernetes, with separate workloads for the web app, the download worker, and Redis.
- Traffic appears to enter through a Kubernetes Ingress on host `pi.home`, then route by subpath `/ytdl` to the app service.
- The application is built to live under a subpath, not at `/`; both the frontend and backend are hard-coded for `/ytdl`.
- Container images are pulled from `pi.home:30500/...`, which strongly suggests a registry hosted on the same home-network machine or cluster.
- Persistent storage uses `PersistentVolumeClaim`s backed by `nfs-storage`, which suggests shared network storage on the home network.

## Evidence used

- `README.md:27` says: "I host this on my Raspberry Pi."
- `k8s/app.yml` defines the main app deployment, service, and ingress.
- `k8s/worker.yml` defines the separate background worker deployment.
- `k8s/redis.yml` defines Redis as an in-cluster dependency.
- `k8s/pvc.yml` defines persistent volumes using `nfs-storage`.
- `Dockerfile` shows the runtime image and how yt-dlp, ffmpeg, Bun, and Deno are packaged.
- `server.ts`, `build.ts`, `src/App.tsx`, and `src/trpc/client.tsx` show that the app is intentionally served from `/ytdl`.
- `podman-kube.yml` looks like an older or alternative single-pod deployment approach, useful for understanding evolution and local hosting assumptions.

## High-level architecture

The repo points to a three-part runtime setup:

1. `ytdl` web app
   - Serves the React frontend.
   - Hosts the tRPC API.
   - Exposes port `3000` inside the container.

2. `ytdl-worker`
   - Runs the actual download jobs using `yt-dlp`.
   - Pulls jobs from Redis via BullMQ.
   - Writes downloaded media and metadata into shared storage under `data/videos/...`.

3. `redis`
   - Acts as the BullMQ backing store.
   - Provides queue state for waiting, active, completed, and failed jobs.

The app and worker use the same container image. The difference is only the startup command:

- App: default container command from `Dockerfile` -> `bun run server.ts`
- Worker: overridden command in `k8s/worker.yml:20` -> `bun run src/worker/worker.ts`

## Build and image strategy

The build flow appears to be:

1. Build frontend assets with Bun.
2. Bake the app into a single runtime image.
3. Build for `linux/arm64/v8`, which matches Raspberry Pi ARM64 hosting.
4. Push images to a registry.

From `README.md`:

```bash
podman build -t ddanielgal/ytdl --platform linux/arm64/v8 .
podman push ddanielgal/ytdl
```

That ARM64 target is one of the strongest indicators that the deployment target is a Raspberry Pi running a 64-bit OS.

The Kubernetes manifests do not point at Docker Hub directly. Instead they reference:

- `pi.home:30500/ddanielgal/ytdl:latest`

That implies the cluster pulls from a registry exposed at `pi.home` on port `30500`. The repo does not define that registry, but the most likely explanations are:

- a local registry running on the Raspberry Pi,
- or a registry service exposed from the cluster/home network on port `30500`.

## Kubernetes setup

### Main app

`k8s/app.yml` contains three resources:

- `ConfigMap` named `ytdl`
- `Deployment` named `ytdl`
- `Service` named `ytdl`
- `Ingress` named `ytdl`

Important details:

- `Deployment` replica count is `1`.
- Container listens on port `3000`.
- `Service` exposes port `80` and forwards to target port `3000`.
- `Ingress` routes host `pi.home` and path prefix `/ytdl` to service `ytdl:80`.

### Worker

`k8s/worker.yml` defines a separate `Deployment` with:

- replica count `1`,
- the same image as the app,
- startup command `bun run src/worker/worker.ts`,
- a volume mount at `/app/data`,
- a secret-backed mount at `/etc/ytdl`.

This shows the download execution path is intentionally separated from the HTTP app. The web app enqueues work; the worker performs the downloads.

### Redis

`k8s/redis.yml` defines:

- a `Deployment` with one `redis:7-alpine` container,
- a `Service` named `redis` on port `6379`,
- a PVC-backed data mount at `/data/redis`.

App and worker connect to Redis by service DNS name:

- `REDIS_HOST=redis`
- `REDIS_PORT=6379`

That is standard in-cluster service discovery.

### Persistent storage

`k8s/pvc.yml` defines two claims:

- `ytdlq` with `storageClassName: nfs-storage`, `ReadWriteMany`, `100Gi`
- `redis` with `storageClassName: nfs-storage`, `ReadWriteOnce`, `1Gi`

This is important for networking and home-lab interpretation:

- `nfs-storage` strongly implies shared storage exported over NFS somewhere on the home network.
- `ReadWriteMany` for `ytdlq` implies the download data is intended to be mountable from more than one pod/node.
- That fits a home-cluster setup where media is stored centrally and consumed by other systems like Jellyfin.

## Raspberry Pi deployment picture

The repo does not define the Raspberry Pi OS, Kubernetes distro, or hardware model, but several details point to the Pi being central to hosting:

- `README.md:27` explicitly says it is hosted on a Raspberry Pi.
- Images are built for `linux/arm64/v8`.
- The ingress host is `pi.home`.
- The image registry is addressed as `pi.home:30500`.

The simplest reading is:

- the Raspberry Pi is either the Kubernetes node itself,
- or the main node/front door for the cluster,
- and it is known on the home network as `pi.home`.

## Ingress and home-network accessibility

### External URL

The most likely LAN URL is:

- `http://pi.home/ytdl`

This comes directly from `k8s/app.yml`:

- host: `pi.home`
- path prefix: `/ytdl`

### How traffic likely flows

1. A device on the home network resolves `pi.home`.
2. The HTTP request reaches the ingress controller listening for that host.
3. The ingress rule matches path prefix `/ytdl`.
4. Traffic is forwarded to Kubernetes service `ytdl` on port `80`.
5. The service forwards to container port `3000` in the app pod.
6. The app serves either frontend assets, SPA routes, or tRPC API requests under the `/ytdl` base path.

### What the repo does not define

The repo does not include:

- the ingress controller installation,
- an `ingressClassName`,
- any controller-specific annotations,
- TLS or certificate resources,
- external DNS config,
- router config,
- port-forwarding or WAN exposure.

So the exact ingress implementation is unknown from this repo alone. It could be Traefik, NGINX Ingress, or another controller already installed in the cluster. Because there is no TLS or internet-facing config here, the safest conclusion is that this is intended primarily for home-network HTTP access.

### How `pi.home` is probably resolved

The repo does not define DNS, but `pi.home` suggests one of these LAN-resolution mechanisms:

- router/local DNS entry,
- mDNS/Bonjour-style naming,
- or static `/etc/hosts` entries on client devices.

This is an inference, not something explicitly configured in the repo.

## Subpath hosting

Subpath support is deliberate and consistent across the app.

### Backend

`server.ts` hard-codes:

- `BASE_PATH = "/ytdl"`
- `TRPC_PREFIX = "/ytdl/api/trpc"`

The server behavior is built around that base path:

- `/ytdl` redirects to `/ytdl/`
- static files are served from `/ytdl/...`
- tRPC requests are handled at `/ytdl/api/trpc`
- SPA routes under `/ytdl/...` return `index.html`
- requests outside that prefix return `404`

### Frontend build

`build.ts` sets:

- `publicPath: "/ytdl/"`

That means built asset URLs are emitted relative to the `/ytdl` subpath.

### Frontend router

`src/App.tsx` uses:

- `BrowserRouter basename="/ytdl"`

So client-side navigation also assumes the app lives under `/ytdl`, not `/`.

### API client

`src/trpc/client.tsx` uses:

- `return "/ytdl/api/trpc"`

So browser-side API calls are also anchored to the subpath.

### Practical implication

This deployment will work correctly behind ingress path routing for `/ytdl` without needing a rewrite, because the app itself expects to live there.

## Internal service networking

Inside Kubernetes, the networking model appears straightforward:

- The app and worker both receive env vars from the `ytdl` `ConfigMap`.
- The app and worker connect to Redis using the service name `redis`.
- Redis is only exposed internally through its Kubernetes service.
- The app is exposed internally through service `ytdl`, then externally through ingress.

There is no evidence in the repo that Redis is exposed outside the cluster in the Kubernetes setup.

## Queue and download flow

The runtime flow appears to be:

1. User opens `http://pi.home/ytdl` from a device on the home network.
2. Frontend calls the tRPC API at `/ytdl/api/trpc`.
3. `addVideo` enqueues a BullMQ job in Redis.
4. `ytdl-worker` pulls the job from Redis.
5. Worker runs `yt-dlp` with cookies and ffmpeg available inside the container.
6. Output is written to `data/videos/%(uploader)s/%(upload_date>%Y)s/...`.
7. Queue state is read back from Redis so the UI can show waiting/active/completed/failed state.

`README.md` also says Jellyfin picks up the downloaded files, which suggests the shared media storage is either:

- the same NFS-backed location Jellyfin reads from,
- or a path later synchronized/mounted into Jellyfin.

## Storage and secret handling

The worker deployment mounts:

- persistent media storage at `/app/data`
- cookies secret at `/etc/ytdl`

The config expects:

- `YTDLP_COOKIES_PATH=/etc/ytdl/cookies.txt`

So the worker likely consumes a Kubernetes `Secret` named `ytdl-cookies` containing `cookies.txt`.

This secret is not defined in the repo, which usually means it is created separately and kept out of source control.

## Older or alternate deployment model

`podman-kube.yml` shows a different deployment shape:

- a single `Pod` containing `redis`, `app`, and `worker`,
- host ports `3000` and `6379`,
- hostPath mounts for `./data` and `./cookies.txt`,
- `REDIS_HOST=localhost` instead of `redis`.

This looks like either:

- an earlier pre-Kubernetes arrangement,
- or a local single-machine deployment/testing setup.

Compared with the Kubernetes manifests, it shows the same logical architecture, but collapsed into one pod on one host.

## Important gaps or inconsistencies found

These findings may matter operationally:

### App deployment does not mount the shared data volume

`src/trpc/routers/_app.ts:42` reads from the local `data` directory to list videos, but `k8s/app.yml` does not mount `/app/data` into the app pod.

That means one of the following must be true:

- the current Kubernetes deployment does not rely on `listVideos`,
- the manifest is incomplete,
- or the app pod will not see downloaded files in Kubernetes even though the worker can write them.

### App deployment does not mount the cookies secret

The app probably does not need cookies directly, but it still imports env parsing that requires `YTDLP_PATH`. The current `ConfigMap` satisfies that. Cookies appear operationally necessary only for the worker.

### No namespace is specified

None of the manifests define a namespace, so they deploy into whatever the current kubectl namespace is at apply time, usually `default` unless overridden elsewhere.

### No probes, requests, or limits

The manifests do not include:

- readiness probes,
- liveness probes,
- CPU or memory requests/limits,
- security context,
- affinity/tolerations.

That suggests a relatively small home-lab style deployment rather than a production-hardened cluster manifest set.

### Ingress controller and external exposure are out of band

Ingress rules are present, but the actual controller and network edge configuration are not. So the repo documents the application routing intent, but not the full cluster edge setup.

## Best reconstruction of the deployed topology

The most likely real-world topology behind this repo is:

- A Raspberry Pi hosts or fronts a small Kubernetes cluster.
- The Pi is reachable on the home LAN as `pi.home`.
- A registry is available at `pi.home:30500` and stores the ARM64 app image.
- Kubernetes runs three workloads: `ytdl`, `ytdl-worker`, and `redis`.
- An ingress controller on the cluster accepts requests for `pi.home`.
- Requests for `/ytdl` are forwarded to the app service.
- The worker talks to Redis internally and writes media to NFS-backed shared storage.
- Jellyfin likely reads from that same shared storage, or from a mount of it.

## Confidence level

High confidence:

- Raspberry Pi hosting intent
- Kubernetes-based deployment structure
- ingress host/path of `pi.home` + `/ytdl`
- subpath-aware application design
- Redis-backed queueing
- ARM64 image target
- NFS-backed persistent storage

Medium confidence:

- `pi.home` being accessible only on the home network
- a local registry at `pi.home:30500`
- NFS being provided by another home-network machine or service

Low confidence / not provable from repo alone:

- exact Kubernetes distro (`k3s`, `microk8s`, `kubeadm`, etc.)
- exact ingress controller (`traefik`, `nginx`, etc.)
- how DNS for `pi.home` is configured
- whether the app is accessible from outside the home network

## Bottom line

This repo describes a home-lab style Kubernetes deployment on or around a Raspberry Pi. The app is meant to be reached on the LAN at `pi.home` under the `/ytdl` subpath, with ingress handling host/path routing, Redis handling queue state, a separate worker handling downloads, and NFS-backed storage persisting media and Redis data. The repo gives a clear picture of the application-side deployment model, but not the full surrounding cluster edge infrastructure.
