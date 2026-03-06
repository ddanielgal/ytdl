# Plan: move ytdl to a dedicated NetBird hostname

This plan describes how to keep hosting this app on the Raspberry Pi, remove the `/ytdl` subpath requirement, and access it through your NetBird mesh using a dedicated hostname such as `ytdl.mink.danielgal.eu` or `ytdl.pi.mink.danielgal.eu`.

It is based on:

- the current repo structure and Kubernetes manifests,
- the current app routing code,
- and current NetBird docs on DNS, Custom Zones, Networks, Network Routes, and Reverse Proxy.

## Recommendation

Use a dedicated hostname and serve the app at `/`, not under a subpath.

Recommended target hostname:

- `ytdl.pi.mink.danielgal.eu`

Why this is the safest default:

- it keeps the service clearly attached to the Pi peer,
- it avoids reusing the bare `mink.danielgal.eu` namespace too aggressively,
- and it is easier to reason about if you later expose more services from the same Pi.

`ytdl.mink.danielgal.eu` is also fine if you want a cleaner service-first name. The rest of the plan works for either hostname.

## Executive summary

The cleanest setup is:

1. Keep the app on the Raspberry Pi and in Kubernetes.
2. Change the app so it is root-hosted at `/` instead of `/ytdl`.
3. Change the Kubernetes Ingress to route a dedicated host instead of a path prefix.
4. Publish that hostname into your NetBird-accessible DNS path.
5. Keep access private to NetBird peers unless you explicitly decide to use NetBird Reverse Proxy later.

## What NetBird can do here

From the current NetBird docs:

- **DNS management**: NetBird can distribute nameservers to peers, including match domains and search domains.
- **Automatic peer names**: NetBird can automatically assign peer domain names.
- **Custom Zones**: NetBird can distribute private DNS records directly to peers, but custom zones must not conflict with the NetBird peer DNS domain.
- **Networks / domain resources**: NetBird can route access to resources behind routing peers, including domain-based resources.
- **Reverse Proxy**: NetBird can expose services through its reverse proxy, but this is intended for internet-facing access, is currently beta, and for self-hosted deployments requires Traefik plus proxy-specific domain setup.

### Important NetBird conclusion

For your goal, **NetBird Reverse Proxy is not the primary recommendation**.

Reason:

- you want access through your personal mesh network,
- not necessarily to expose the app publicly,
- and the reverse proxy adds more moving parts than you need.

So the main plan is a **private mesh-only hostname** using NetBird-friendly DNS, not NetBird Reverse Proxy.

## Current repo constraints

Right now the app is tightly coupled to `/ytdl`.

### App coupling to subpath

The repo currently hard-codes subpath hosting in multiple places:

- `server.ts` sets `BASE_PATH = "/ytdl"`
- `server.ts` serves SPA routes only under `/ytdl`
- `src/App.tsx` uses `BrowserRouter basename="/ytdl"`
- `src/trpc/client.tsx` calls `/ytdl/api/trpc`

### Current Kubernetes routing

`k8s/app.yml` currently exposes the app through:

- host `pi.home`
- path prefix `/ytdl`

That means the app, ingress, and browser routing are all aligned around subpath hosting today.

## Target architecture

### Desired user experience

After the change, a NetBird-connected client should open:

- `https://ytdl.pi.mink.danielgal.eu/`

or:

- `https://ytdl.mink.danielgal.eu/`

And the app should work entirely at root:

- frontend at `/`
- queue page at `/queue`
- tRPC at `/api/trpc`

### Network flow

The desired request path becomes:

1. NetBird peer resolves `ytdl.pi.mink.danielgal.eu`.
2. DNS returns the Raspberry Pi-reachable address for the ingress entry point.
3. Request reaches the ingress controller on the Pi's cluster.
4. Ingress matches by **host**, not by subpath.
5. Ingress forwards to service `ytdl`.
6. Service forwards to the app pod on port `3000`.
7. App serves frontend routes from `/` and API from `/api/trpc`.

## Recommended implementation path

## 1. Make the app root-hosted

This is the most important code change.

### Goal

Remove the `/ytdl` base path assumption and make the app behave like a normal single-host web app.

### Planned code changes

#### `server.ts`

Replace the fixed base-path model with root routes.

Current behavior:

- app routes only exist under `/ytdl`
- API exists under `/ytdl/api/trpc`

Target behavior:

- `/` -> app
- `/queue` -> app
- `/api/trpc` -> tRPC handler

Suggested direction:

```ts
const TRPC_PREFIX = "/api/trpc";

serve({
  routes: {
    "/": indexHtml,
    "/queue": indexHtml,
    "/queue/": indexHtml,
  },
  fetch(req) {
    const pathname = new URL(req.url).pathname;

    if (pathname.startsWith(TRPC_PREFIX)) {
      return tRPCHandler(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});
```

#### `src/App.tsx`

Remove the router basename.

Current:

```tsx
<BrowserRouter basename="/ytdl">
```

Target:

```tsx
<BrowserRouter>
```

#### `src/trpc/client.tsx`

Change the API base URL from:

```ts
return "/ytdl/api/trpc";
```

to:

```ts
return "/api/trpc";
```

### Optional improvement

If you want to keep future flexibility, introduce a shared `APP_BASE_PATH` helper with default `""` and use it in server/router/client code.

But for your stated goal, the simplest approach is better:

- remove subpath support,
- serve from `/`,
- keep the app configuration minimal.

## 2. Switch Kubernetes ingress from path-based routing to host-based routing

### Current ingress shape

The current ingress is effectively:

```yaml
spec:
  rules:
    - host: pi.home
      http:
        paths:
          - path: /ytdl
```

### Target ingress shape

Use a dedicated host and route `/`.

Example for `ytdl.pi.mink.danielgal.eu`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ytdl
spec:
  ingressClassName: traefik
  rules:
    - host: ytdl.pi.mink.danielgal.eu
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ytdl
                port:
                  number: 80
```

If your cluster uses a different ingress controller, replace `ingressClassName` accordingly or omit it if your cluster has a default ingress class.

### TLS

If you want HTTPS on the private hostname, add TLS at the ingress layer.

Example:

```yaml
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - ytdl.pi.mink.danielgal.eu
      secretName: ytdl-tls
  rules:
    - host: ytdl.pi.mink.danielgal.eu
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ytdl
                port:
                  number: 80
```

For a private-only service, you have three practical TLS options:

- start with plain HTTP over NetBird,
- use cert-manager with DNS-01 if your public DNS provider supports it,
- or use an internal/private certificate trusted by your own devices.

## 3. Clean up the Kubernetes app structure

The current structure is close, but I would change it slightly while doing the hostname migration.

### Recommended resource layout

- namespace: `ytdl` or `media`
- `ConfigMap`: runtime env shared by app and worker
- `Secret`: yt-dlp cookies
- `Deployment`: web app
- `Deployment`: worker
- `Service`: web app ClusterIP
- `Deployment` or `StatefulSet`: Redis
- `Service`: Redis ClusterIP
- `PersistentVolumeClaim`: shared media data
- `PersistentVolumeClaim`: Redis data
- `Ingress`: dedicated hostname

### Important manifest fix

The app code reads from `data`, but the current app deployment does not mount `/app/data`.

If you want the app pod to see downloaded files, mount the same shared PVC into the app container too.

Recommended app deployment shape:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ytdl
  namespace: ytdl
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ytdl
      component: app
  template:
    metadata:
      labels:
        app: ytdl
        component: app
    spec:
      containers:
        - name: ytdl
          image: pi.mink.danielgal.eu:30500/ddanielgal/ytdl:latest
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: ytdl
          volumeMounts:
            - name: ytdl-data
              mountPath: /app/data
      volumes:
        - name: ytdl-data
          persistentVolumeClaim:
            claimName: ytdl-data
```

### Worker deployment

Keep the split app/worker pattern. It is the right structure.

Example:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ytdl-worker
  namespace: ytdl
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ytdl
      component: worker
  template:
    metadata:
      labels:
        app: ytdl
        component: worker
    spec:
      containers:
        - name: ytdl-worker
          image: pi.mink.danielgal.eu:30500/ddanielgal/ytdl:latest
          command: ["bun", "run", "src/worker/worker.ts"]
          envFrom:
            - configMapRef:
                name: ytdl
          volumeMounts:
            - name: ytdl-data
              mountPath: /app/data
            - name: ytdl-cookies
              mountPath: /etc/ytdl
      volumes:
        - name: ytdl-data
          persistentVolumeClaim:
            claimName: ytdl-data
        - name: ytdl-cookies
          secret:
            secretName: ytdl-cookies
```

### ConfigMap

Suggested runtime config:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ytdl
  namespace: ytdl
data:
  YTDLP_PATH: "/usr/local/bin/yt-dlp"
  YTDLP_COOKIES_PATH: "/etc/ytdl/cookies.txt"
  REDIS_HOST: "redis"
  REDIS_PORT: "6379"
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ytdl
  namespace: ytdl
spec:
  selector:
    app: ytdl
    component: app
  ports:
    - name: http
      port: 80
      targetPort: 3000
```

### Redis

You can keep Redis simple.

Suggested options:

- **minimal change**: keep `Deployment` + PVC as you already do
- **slightly cleaner**: move Redis to a `StatefulSet`

For a small Pi-hosted setup, keeping Redis as a deployment is acceptable if you want the least churn.

## 4. Choose how the hostname resolves inside NetBird

This is the main NetBird design decision.

There are three realistic options.

## Option A: existing DNS for `mink.danielgal.eu` + NetBird nameserver distribution

This is the best option if you want to use **exactly** `ytdl.mink.danielgal.eu` or `ytdl.pi.mink.danielgal.eu`.

### How it works

1. You host or control DNS for `mink.danielgal.eu`.
2. You add an `A` record for the ytdl hostname.
3. That record points to the Raspberry Pi's **NetBird IP** or another address reachable only to NetBird peers.
4. In NetBird, you distribute the relevant nameserver to your peers.

### Why this fits the docs well

NetBird docs support:

- custom nameservers,
- match domains,
- search domains,
- and using internal DNS servers behind routing peers if needed.

### Good fit when

- you already control DNS for `mink.danielgal.eu`,
- you want the service name to live in your real domain,
- and you want the same hostname across devices.

### Example

If the Pi's NetBird IP is `100.x.y.z`, create:

- `ytdl.pi.mink.danielgal.eu -> 100.x.y.z`

or:

- `ytdl.mink.danielgal.eu -> 100.x.y.z`

Then configure NetBird DNS:

- Nameserver distributed to the peer groups that should resolve `mink.danielgal.eu`
- Match domain: `mink.danielgal.eu`

### NetBird notes

Per current docs:

- Linux peers always get NetBird DNS behavior for peer domains.
- Match-domain nameservers work best on macOS, Windows 10+, and Linux with `systemd-resolved`.
- If the DNS server is behind a routed private network, NetBird recommends using Networks plus an access policy for UDP 53.

### Recommendation

If you already have a DNS server for `mink.danielgal.eu`, this is the most direct way to get the exact hostname you want.

## Option B: NetBird Custom Zone

This is the best option if you want a fully private service name without running your own DNS server.

### How it works

1. Create a NetBird Custom Zone.
2. Add an `A` record for `ytdl`.
3. Distribute that zone to the peer groups that should access the app.

### Important limitation

Per the current docs, a Custom Zone **must not conflict with the NetBird peer DNS domain**.

This matters a lot here because your peer is already named `pi.mink.danielgal.eu`.

If your NetBird peer DNS domain is actually `mink.danielgal.eu`, then creating a Custom Zone on that same domain may not be allowed.

### What this means in practice

- If `mink.danielgal.eu` is already the NetBird peer DNS domain, do **not** assume Custom Zones can host `ytdl.mink.danielgal.eu`.
- Verify in the NetBird dashboard before committing to this path.

### Good fit when

- you do not want to run an internal DNS server,
- and your chosen zone does not conflict with the peer DNS domain.

### Possible variant

If the conflict exists, use a dedicated internal service zone such as:

- `home.mink.danielgal.eu`
- `mesh.mink.danielgal.eu`
- `internal.mink.danielgal.eu`

Then create:

- `ytdl.home.mink.danielgal.eu`

This is not your first-choice hostname, but it is operationally clean.

## Option C: NetBird Reverse Proxy

This is the right option only if you later decide that the app should be reachable from the public internet or through NetBird's proxy layer rather than just through direct peer-to-peer/private routing.

### What the docs say

Current NetBird docs describe Reverse Proxy as:

- available for **self-hosted** deployments,
- currently **beta**,
- requiring **Traefik** as the external reverse proxy,
- supporting built-in cluster domains and custom domains,
- and able to provision automatic TLS certificates.

### Why I do not recommend it as the first step

- it is designed to expose services outward,
- it introduces proxy cluster setup and wildcard DNS verification,
- and it is more complex than needed for a private mesh-only app.

### When it becomes attractive

Use it if you later want:

- browser access from non-NetBird devices,
- NetBird-managed authentication in front of the app,
- public TLS with minimal per-app ingress exposure.

### Custom domain support in current docs

NetBird supports custom domains for reverse proxy services via wildcard CNAME verification.

For self-hosted proxy clusters, the docs require:

- a proxy domain different from the management domain,
- `proxy` and `*.proxy` CNAMEs pointing at the NetBird host,
- then custom domain verification for your own service domains.

This is useful, but separate from your main private-mesh goal.

## Recommended hostname strategy

### Preferred

- `ytdl.pi.mink.danielgal.eu`

### Alternative

- `ytdl.mink.danielgal.eu`

### Why prefer the `pi` form first

- it keeps the service explicitly attached to the Pi peer,
- it avoids future confusion if you later move some services off the Pi,
- and it is easier to alias later if you want `ytdl.mink.danielgal.eu` as the stable public-facing name.

## Detailed rollout plan

## Phase 1: application changes

1. Remove the hard-coded `/ytdl` base path from `server.ts`.
2. Remove `basename="/ytdl"` from `src/App.tsx`.
3. Change tRPC client URL to `/api/trpc` in `src/trpc/client.tsx`.
4. Verify local dev still works at `http://localhost:3000/`.

### Validation for phase 1

- `/` loads the feeds page
- `/queue` loads directly on refresh
- API requests go to `/api/trpc`
- no asset URLs contain `/ytdl/`

## Phase 2: Kubernetes manifest cleanup

1. Introduce a namespace, e.g. `ytdl`.
2. Update manifests to include that namespace consistently.
3. Mount the shared media PVC into the app pod as well as the worker pod.
4. Keep the worker and Redis split as separate workloads.
5. Update ingress to host-based routing.
6. Update image host if you want to stop using `pi.home:30500`.

### Registry note

The repo currently uses `pi.home:30500/ddanielgal/ytdl:latest`.

If you want naming consistency with the new access model, consider moving to:

- `pi.mink.danielgal.eu:30500/ddanielgal/ytdl:latest`

Only do this if your Kubernetes node or nodes can resolve and reach that hostname. If not, leave the registry hostname alone for now and decouple the app URL migration from the image registry migration.

## Phase 3: DNS inside NetBird

Choose one of the DNS strategies above.

### Recommended order

1. First try **Option A** if you already operate DNS for `mink.danielgal.eu`.
2. Use **Option B** only if Custom Zone compatibility with your peer DNS domain is confirmed.
3. Leave **Option C** for later unless you explicitly want public exposure.

## Phase 4: switch clients over

1. Apply the new manifests.
2. Confirm the ingress responds for the new hostname.
3. Test from one NetBird-connected laptop/phone.
4. Remove old `/ytdl` links/bookmarks.
5. Retire the old `pi.home/ytdl` ingress rule after confidence is high.

## Example manifest set

Below is a coherent target manifest structure.

### Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ytdl
```

### PVCs

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ytdl-data
  namespace: ytdl
spec:
  storageClassName: nfs-storage
  accessModes: [ReadWriteMany]
  resources:
    requests:
      storage: 100Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis
  namespace: ytdl
spec:
  storageClassName: nfs-storage
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
```

### App service and ingress

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ytdl
  namespace: ytdl
spec:
  selector:
    app: ytdl
    component: app
  ports:
    - name: http
      port: 80
      targetPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ytdl
  namespace: ytdl
spec:
  ingressClassName: traefik
  rules:
    - host: ytdl.pi.mink.danielgal.eu
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ytdl
                port:
                  number: 80
```

### Redis service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: ytdl
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
```

## NetBird-specific plan details

## If using NetBird nameservers

Use this when `mink.danielgal.eu` is resolved by a DNS server you control.

### Steps

1. Add or confirm an `A` record for the new ytdl hostname.
2. In NetBird, go to `DNS -> Nameservers`.
3. Add a custom nameserver that can answer for `mink.danielgal.eu`.
4. Add `mink.danielgal.eu` as a match domain.
5. Distribute it to the groups that should access ytdl.
6. If that DNS server is on a private subnet behind a routing peer, add it as a NetBird Network resource and allow UDP 53.

### Pros

- exact hostname control
- works well with your real domain
- easy to add more services later

### Cons

- requires a DNS server authoritative for the zone or subzone

## If using NetBird Custom Zones

Use this only if the zone does not conflict with the peer DNS domain.

### Steps

1. In NetBird, go to `DNS -> Zones`.
2. Create a zone for a non-conflicting internal service domain.
3. Add an `A` record pointing to the Pi's NetBird IP.
4. Distribute it to the right peer groups.

### Pros

- no separate DNS server required
- peer-scoped visibility is very clean

### Cons

- may not support `mink.danielgal.eu` directly if that is the existing peer DNS domain

## If using NetBird Reverse Proxy later

Only do this if you want broader exposure.

### Steps from the current docs direction

1. Ensure your NetBird deployment is self-hosted.
2. Ensure Traefik is the external reverse proxy.
3. Enable the NetBird proxy service.
4. Configure a proxy domain different from the management domain.
5. Create required wildcard proxy DNS records.
6. Add a reverse proxy service in the NetBird dashboard.
7. Point it to the Pi peer or another reachable resource.
8. Optionally verify a custom domain and bind it to the service.

### Important note

This is for exposure through NetBird's proxy layer, not ordinary peer-to-peer private DNS access.

## Operational advice

### Keep the app URL migration and DNS migration separate

Do this in two independent moves:

1. make the app root-hosted first,
2. then move ingress host and DNS.

That way, if DNS is messy, you still have a clean app deployment.

### Keep old access temporarily

For a short transition period, it is reasonable to support both:

- old: `http://pi.home/ytdl`
- new: `https://ytdl.pi.mink.danielgal.eu/`

Once the new path is stable, remove the old one.

### Keep this private unless you explicitly want public access

Your current goal reads like a private homelab service. NetBird DNS + private ingress is the lowest-complexity version of that design.

## Risks and watch-outs

### DNS conflict risk

The biggest unknown is whether `mink.danielgal.eu` is already your NetBird peer DNS domain. If it is, NetBird Custom Zones may not be able to own that zone.

### Ingress controller details are still out-of-band

The repo does not define the ingress controller, so you will need to align the ingress manifest with whatever the Pi cluster already runs, likely Traefik or NGINX.

### TLS may require separate work

If you want real HTTPS for `ytdl.mink.danielgal.eu` without public exposure, DNS-01 certificate issuance is the cleanest route, but it is extra setup.

### Registry hostname is a separate concern

Changing the service URL does not require changing the image registry host. Avoid coupling those unless you want that migration too.

## Final recommendation

Implement this in the following order:

1. Remove `/ytdl` assumptions from the app.
2. Update Kubernetes ingress to a dedicated hostname at `/`.
3. Mount the shared data PVC into the app deployment as well.
4. Publish `ytdl.pi.mink.danielgal.eu` through NetBird-friendly DNS.
5. Add TLS only after the hostname and routing are stable.

If you want the exact shortest path with the fewest NetBird surprises, the best practical target is:

- app URL: `http://ytdl.pi.mink.danielgal.eu/` first
- then later: `https://ytdl.pi.mink.danielgal.eu/`

And the best NetBird integration path is:

- use NetBird-distributed nameserver resolution for `mink.danielgal.eu` if you already control that DNS,
- avoid NetBird Reverse Proxy unless you decide the app should be exposed beyond the private mesh.
