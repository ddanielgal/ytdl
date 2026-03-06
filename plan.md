# Plan: move ytdl to a dedicated NetBird hostname

This plan describes how to keep hosting this app on the Raspberry Pi, remove the `/ytdl` subpath requirement, and access it through your NetBird mesh using a dedicated private hostname distributed by a NetBird Custom Zone.

It is based on:

- the current repo structure and Kubernetes manifests,
- the current app routing code,
- and current NetBird docs on DNS, Custom Zones, Networks, Network Routes, and Reverse Proxy.

## Recommendation

Use a dedicated hostname and serve the app at `/`, not under a subpath.

Use a NetBird Custom Zone for private DNS, and use plain HTTP over the NetBird mesh unless you later decide to introduce explicit certificate management.

Recommended hostname shape:

- `ytdl.mink.home.arpa`

Why this is the safest default:

- it stays fully private and does not depend on public DNS,
- it avoids conflicting with your existing peer naming under `mink.danielgal.eu`,
- `home.arpa` is purpose-built for home-network naming,
- and it keeps the setup simple: NetBird handles encrypted transport, Kubernetes serves plain HTTP.

## Executive summary

The cleanest setup is:

1. Keep the app on the Raspberry Pi and in Kubernetes.
2. Change the app so it is root-hosted at `/` instead of `/ytdl`.
3. Change the Kubernetes Ingress to route a dedicated host instead of a path prefix.
4. Publish a private hostname through a NetBird Custom Zone.
5. Use plain HTTP inside the mesh and keep the service private to NetBird peers.

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

- `http://ytdl.mink.home.arpa/`

You can swap that hostname later if you choose a different private zone, but the app should behave the same.

And the app should work entirely at root:

- frontend at `/`
- queue page at `/queue`
- tRPC at `/api/trpc`

### Network flow

The desired request path becomes:

1. NetBird peer resolves `ytdl.mink.home.arpa`.
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

Example for `ytdl.mink.home.arpa`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ytdl
spec:
  ingressClassName: traefik
  rules:
    - host: ytdl.mink.home.arpa
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

For your stated preference, the plan should use plain HTTP over NetBird.

Important distinction:

- NetBird encrypts transport between peers using WireGuard.
- NetBird does **not** terminate browser HTTPS for an ordinary private service.
- So there is no "NetBird-only TLS termination" mode where Kubernetes can stay simple and the browser still sees normal HTTPS without any certificate work.

That means the practical choices are:

- `http://ytdl.mink.home.arpa` over the encrypted NetBird mesh, or
- introduce separate certificate management at the app/ingress layer.

Because you explicitly do not want extra cluster resources such as `cert-manager`, the recommended plan is:

- keep Kubernetes ingress on plain HTTP,
- keep the app private to NetBird peers,
- rely on NetBird/WireGuard for transport encryption.

In other words: the browser URL will be `http://...`, but the traffic still travels inside the encrypted mesh.

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


### App deployment

Per your note, do not change the current data arrangement as part of this migration. Treat the data layout as out of scope for this plan.

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
          image: pi.home:30500/ddanielgal/ytdl:latest
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

You chose NetBird Custom Zones, so this is now the primary path.

## Chosen option: NetBird Custom Zone

This is the best option if you want a fully private service name without running your own DNS server.

### What NetBird docs allow

Per the current docs, a Custom Zone domain:

- must be a valid FQDN,
- must not conflict with the NetBird peer DNS domain,
- is distributed only to the selected peer groups,
- and can contain `A`, `AAAA`, and `CNAME` records.

The docs do **not** say you are limited to `.internal` or `.local`.

So the real constraint is not the TLD itself. The real constraints are:

- valid FQDN syntax,
- no conflict with your NetBird peer DNS domain,
- and picking a name that behaves well on client devices.

### Practical hostname guidance

NetBird Custom Zones work best when you think in terms of:

- a **zone**, such as `mink.home.arpa`,
- plus a **record hostname**, such as `ytdl`.

That produces the final app hostname:

- `ytdl.mink.home.arpa`

This is better than trying to think only in terms of a one-off hostname like `ytdl.internal`.

### Brainstorm: candidate private domains

Best candidates:

- `mink.home.arpa` -> app becomes `ytdl.mink.home.arpa`
- `mesh.home.arpa` -> app becomes `ytdl.mesh.home.arpa`
- `services.home.arpa` -> app becomes `ytdl.services.home.arpa`
- `danielgal.home.arpa` -> app becomes `ytdl.danielgal.home.arpa`

Acceptable if NetBird accepts them and you prefer the style:

- `mink.internal` -> `ytdl.mink.internal`
- `danielgal.internal` -> `ytdl.danielgal.internal`
- `mink.private` -> `ytdl.mink.private`
- `mink.test` -> `ytdl.mink.test`

Candidates to avoid or treat cautiously:

- `*.local` because `.local` commonly conflicts with mDNS / Bonjour on many systems
- your existing peer DNS domain, if that is `mink.danielgal.eu`
- made-up TLDs like `.lan`, `.home`, or `.corp`, which are common in homelabs but historically more collision-prone

### Recommended domain choice

The best fit for this plan is:

- zone: `mink.home.arpa`
- record: `ytdl`
- final hostname: `ytdl.mink.home.arpa`

Why:

- `home.arpa` is specifically intended for home-network naming,
- it avoids `.local` mDNS weirdness,
- it does not depend on your public domain,
- and it keeps the NetBird-only/private intent obvious.

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

### How it works

1. Create a NetBird Custom Zone.
2. Add an `A` record for `ytdl`.
3. Point that record to the Raspberry Pi's NetBird IP.
4. Distribute that zone to the peer groups that should access the app.

### Important limitation

Per the current docs, a Custom Zone **must not conflict with the NetBird peer DNS domain**.

This matters because your peer is already named `pi.mink.danielgal.eu`.

If your NetBird peer DNS domain is `mink.danielgal.eu`, then creating a Custom Zone on that same domain may not be allowed.

That is another reason the `mink.home.arpa` direction is attractive.

### Good fit when

- you do not want to run an internal DNS server,
- you want the service visible only to selected NetBird peers,
- and you are fine using a private service domain rather than your public domain.

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

- `ytdl.mink.home.arpa`

### Good alternatives

- `ytdl.mesh.home.arpa`
- `ytdl.danielgal.home.arpa`
- `ytdl.mink.internal`

### Why prefer the `home.arpa` form first

- it fits a private homelab/mesh service well,
- it avoids `.local` resolver conflicts,
- and it avoids entangling this private service with your public domain naming.

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
3. Keep the worker and Redis split as separate workloads.
4. Update ingress to host-based routing.
5. Keep the current image host unless you separately decide to rename the registry endpoint.

### Registry note

The repo currently uses `pi.home:30500/ddanielgal/ytdl:latest`.

Leave the registry hostname alone for this migration unless you have a separate reason to rename it. The application URL and the container registry endpoint do not need to match.

## Phase 3: DNS inside NetBird

Use a NetBird Custom Zone.

### Recommended order

1. In NetBird, verify the current peer DNS domain so you avoid conflicts.
2. Create zone `mink.home.arpa`.
3. Add record `ytdl` -> `<pi-netbird-ip>`.
4. Distribute the zone to the peer groups that should access the app.
5. Test resolution from one Linux client and one non-Linux client if you use both.

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
    - host: ytdl.mink.home.arpa
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

## NetBird Custom Zone setup

### Concrete setup

1. Open NetBird Dashboard -> `DNS` -> `Zones`.
2. Create zone `mink.home.arpa`.
3. Select the peer groups that should resolve this service.
4. Optionally enable search domain only if you actually want short-name lookups like `ytdl`.
5. Add record:
   - hostname: `ytdl`
   - type: `A`
   - value: `<pi-netbird-ip>`
   - ttl: `300`
6. Save and test `ytdl.mink.home.arpa` from a NetBird-connected client.

### Pros

- no separate DNS server required
- private visibility controlled by NetBird groups
- no public DNS or internet exposure required
- clean fit for a private Pi-hosted app

### Cons

- hostname will be private-only, not a public DNS name
- you must avoid any zone that conflicts with the NetBird peer DNS domain

### Search-domain note

Only enable the zone as a search domain if you truly want users to type just `ytdl`. If you prefer explicitness and fewer resolver surprises, keep search domains disabled and use the full hostname.

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
- new: `http://ytdl.mink.home.arpa/`

Once the new path is stable, remove the old one.

### Keep this private unless you explicitly want public access

Your current goal reads like a private homelab service. NetBird DNS + private ingress is the lowest-complexity version of that design.

## Risks and watch-outs

### DNS conflict risk

The biggest unknown is whether `mink.danielgal.eu` is already your NetBird peer DNS domain. If it is, NetBird Custom Zones may not be able to own that zone.

### Ingress controller details are still out-of-band

The repo does not define the ingress controller, so you will need to align the ingress manifest with whatever the Pi cluster already runs, likely Traefik or NGINX.

### TLS may require separate work

If you later decide you want real HTTPS for `ytdl.mink.home.arpa`, you will need certificate management outside of NetBird transport encryption. That is intentionally out of scope for this plan.

### Registry hostname is a separate concern

Changing the service URL does not require changing the image registry host. Avoid coupling those unless you want that migration too.

## Final recommendation

Implement this in the following order:

1. Remove `/ytdl` assumptions from the app.
2. Update Kubernetes ingress to a dedicated hostname at `/`.
3. Publish `ytdl.mink.home.arpa` through a NetBird Custom Zone.
4. Keep the service on plain HTTP over NetBird.
5. Add certificate management later only if you decide browser HTTPS is worth the extra complexity.

If you want the exact shortest path with the fewest NetBird surprises, the best practical target is:

- app URL: `http://ytdl.mink.home.arpa/`

And the best NetBird integration path is:

- use a NetBird Custom Zone such as `mink.home.arpa`,
- avoid NetBird Reverse Proxy unless you decide the app should be exposed beyond the private mesh.
