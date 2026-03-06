# Plan: move ytdl to a dedicated NetBird hostname

This plan describes how to keep hosting this app on the Raspberry Pi, remove the `/ytdl` subpath requirement, and access it through your NetBird mesh using the private hostname `ytdl.mink.lan` distributed by a NetBird Custom Zone.

It is based on:

- the current repo structure and Kubernetes manifests,
- the current app routing code,
- and current NetBird docs on DNS, Custom Zones, Networks, Network Routes, and Reverse Proxy.

## Recommendation

Use a dedicated hostname and serve the app at `/`, not under a subpath.

Use a NetBird Custom Zone for private DNS, and terminate HTTPS at the Kubernetes ingress using a manually created self-signed certificate stored as a TLS secret.

Chosen hostname:

- `ytdl.mink.lan`

Why this is the chosen shape:

- it stays fully private and does not depend on public DNS,
- it avoids conflicting with your existing peer naming under `mink.danielgal.eu`,
- it is easy to remember,
- and it still keeps the cluster changes small because the only HTTPS addition is a TLS secret plus ingress TLS config.

## Executive summary

The cleanest setup is:

1. Keep the app on the Raspberry Pi and in Kubernetes.
2. Change the app so it is root-hosted at `/` instead of `/ytdl`.
3. Change the Kubernetes Ingress to route a dedicated host instead of a path prefix.
4. Publish a private hostname through a NetBird Custom Zone.
5. Serve the app at `https://ytdl.mink.lan` using a self-signed ingress certificate that you manually trust on peer devices.

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

- `https://ytdl.mink.lan/`

And the app should work entirely at root:

- frontend at `/`
- queue page at `/queue`
- tRPC at `/api/trpc`

### Network flow

The desired request path becomes:

1. NetBird peer resolves `ytdl.mink.lan`.
2. DNS returns the Raspberry Pi-reachable address for the ingress entry point.
3. Request reaches the ingress controller on the Pi's cluster.
4. Ingress matches by **host**, terminates TLS with the self-signed certificate, and routes by `/`.
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

Example for `ytdl.mink.lan`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ytdl
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - ytdl.mink.lan
      secretName: ytdl-tls
  rules:
    - host: ytdl.mink.lan
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

For your updated preference, the plan should use a self-signed certificate with minimal cluster disruption.

Important distinction:

- NetBird encrypts transport between peers using WireGuard.
- NetBird does **not** terminate browser HTTPS for an ordinary private service.
- So there is no "NetBird-only TLS termination" mode where Kubernetes can stay simple and the browser still sees normal HTTPS without any certificate work.

The smallest-change HTTPS design is:

- keep the app container exactly as it is,
- terminate TLS at the ingress controller,
- create one self-signed cert for `ytdl.mink.lan`,
- store it in a Kubernetes TLS secret,
- and manually trust that certificate on your NetBird peer devices.

This avoids adding cluster-wide components such as `cert-manager`.

### Recommended TLS implementation

Use ingress TLS termination with a manually managed secret.

Why this is the least disruptive:

- no app code changes for TLS,
- no sidecar or extra proxy per app,
- no new controller installation,
- just one secret plus ingress `tls:` configuration.

### Concrete certificate approach

Generate a certificate for `ytdl.mink.lan` and create a secret such as `ytdl-tls` in the app namespace.

Example secret shape:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ytdl-tls
  namespace: ytdl
type: kubernetes.io/tls
data:
  tls.crt: <base64-cert>
  tls.key: <base64-key>
```

### Operational note

The simplest version is a self-signed leaf certificate for `ytdl.mink.lan` that you install into the trust store of each peer device/browser.

That works for a single service. If you later add more private HTTPS services, a small private CA would become cleaner, but it is not necessary for this migration.

After this change, the browser URL becomes:

- `https://ytdl.mink.lan`

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

For this plan, the hostname is fixed:

- zone: `mink.lan`
- record: `ytdl`
- final hostname: `ytdl.mink.lan`

This is acceptable for NetBird Custom Zones as long as:

- NetBird accepts the zone as a valid FQDN,
- it does not conflict with the NetBird peer DNS domain,
- and your peer devices rely on NetBird DNS for resolution.

`mink.lan` is not as standards-oriented as `home.arpa`, but since this is a private NetBird-only namespace and you explicitly chose it, the plan should align to that choice.

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

That is why using `mink.lan` as a separate private zone can work well here, provided it does not conflict with the peer DNS domain configured in NetBird.

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

- `ytdl.mink.lan`

### Why this works

- it is short and memorable,
- it is private to your NetBird environment,
- and it is independent from your public DNS domain.

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
2. Create zone `mink.lan`.
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
  tls:
    - hosts:
        - ytdl.mink.lan
      secretName: ytdl-tls
  rules:
    - host: ytdl.mink.lan
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
2. Create zone `mink.lan`.
3. Select the peer groups that should resolve this service.
4. Optionally enable search domain only if you actually want short-name lookups like `ytdl`.
5. Add record:
    - hostname: `ytdl`
    - type: `A`
    - value: `<pi-netbird-ip>`
    - ttl: `300`
6. Save and test `ytdl.mink.lan` from a NetBird-connected client.

## HTTPS setup with self-signed certificate

### Concrete setup

1. Generate a private key and self-signed certificate for `ytdl.mink.lan`.
2. Make sure the certificate includes `subjectAltName=DNS:ytdl.mink.lan`.
3. Create Kubernetes TLS secret `ytdl-tls` in namespace `ytdl`.
4. Reference `ytdl-tls` from the ingress `tls:` section.
5. Export the certificate and install it into the trust store of each peer device/browser that should access the app.
6. Test `https://ytdl.mink.lan` from at least one desktop and one mobile device if you use both.

### Minimal-disruption example commands

```bash
openssl req -x509 -nodes -newkey rsa:4096 -days 825 \
  -keyout ytdl.mink.lan.key \
  -out ytdl.mink.lan.crt \
  -subj "/CN=ytdl.mink.lan" \
  -addext "subjectAltName=DNS:ytdl.mink.lan"
```

```bash
kubectl -n ytdl create secret tls ytdl-tls \
  --cert="ytdl.mink.lan.crt" \
  --key="ytdl.mink.lan.key"
```

If the secret already exists, recreate or update it as part of your deployment workflow.

### Pros

- no separate DNS server required
- private visibility controlled by NetBird groups
- no public DNS or internet exposure required
- clean fit for a private Pi-hosted app
- HTTPS works in the browser once the cert is trusted locally

### Cons

- hostname will be private-only, not a public DNS name
- you must avoid any zone that conflicts with the NetBird peer DNS domain
- certificate trust must be installed manually on each peer device

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
- new: `https://ytdl.mink.lan/`

Once the new path is stable, remove the old one.

### Keep this private unless you explicitly want public access

Your current goal reads like a private homelab service. NetBird DNS + private ingress is the lowest-complexity version of that design.

## Risks and watch-outs

### DNS conflict risk

The biggest unknown is whether `mink.danielgal.eu` is already your NetBird peer DNS domain. If it is, NetBird Custom Zones may not be able to own that zone.

### Ingress controller details are still out-of-band

The repo does not define the ingress controller, so you will need to align the ingress manifest with whatever the Pi cluster already runs, likely Traefik or NGINX.

### TLS may require separate work

You chose to do HTTPS now using a manually trusted self-signed cert. The main operational cost is cert distribution and future renewal on every peer device.

### Registry hostname is a separate concern

Changing the service URL does not require changing the image registry host. Avoid coupling those unless you want that migration too.

## Final recommendation

Implement this in the following order:

1. Remove `/ytdl` assumptions from the app.
2. Update Kubernetes ingress to a dedicated hostname at `/`.
3. Publish `ytdl.mink.lan` through a NetBird Custom Zone.
4. Create self-signed cert + Kubernetes TLS secret `ytdl-tls`.
5. Trust the cert on peer devices and use `https://ytdl.mink.lan`.

If you want the exact shortest path with the fewest NetBird surprises, the best practical target is:

- app URL: `https://ytdl.mink.lan/`

And the best NetBird integration path is:

- use the NetBird Custom Zone `mink.lan`,
- avoid NetBird Reverse Proxy unless you decide the app should be exposed beyond the private mesh.
