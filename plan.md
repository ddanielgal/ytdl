# Traefik simplification plan

Goal: remove the custom host-bound Traefik setup first by trying the simplest viable design:

- no `hostNetwork`
- no direct bind on host `80/443`
- keep Traefik reachable at `100.90.167.160`
- let kube-proxy handle traffic to the Traefik service `externalIPs`

If that fails, fall back to:

- Traefik `NodePort`
- `wt0`-only port redirects to those NodePorts

## Why this first attempt is plausible

The current host already shows kube-proxy rules for:

- `100.90.167.160:80 -> kube-system/traefik:web`
- `100.90.167.160:443 -> kube-system/traefik:websecure`

and those counters are non-zero. That means the Pi is already matching NetBird-destined traffic for the Traefik service by `externalIPs`. Right now the service endpoints happen to be the host itself because Traefik runs on `hostNetwork`. The first experiment is to keep that service exposure model, but make Traefik a normal pod again.

## Current state to preserve if needed

Current live override file on the Pi:

`/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`

Current behavior:

- `hostNetwork: true`
- `service.type: ClusterIP`
- `externalIPs: [100.90.167.160]` already present on the rendered service
- Traefik binds host `80/443`

## Phase 0: backup and baseline

Run on the Pi:

```bash
sudo cp /var/lib/rancher/k3s/server/manifests/traefik-config.yaml /var/lib/rancher/k3s/server/manifests/traefik-config.yaml.bak.$(date +%F-%H%M%S)
kubectl -n kube-system get svc traefik -o yaml > ~/traefik-service.before.yaml
kubectl -n kube-system get deploy traefik -o yaml > ~/traefik-deploy.before.yaml
sudo ss -ltnp | grep -E '(:80|:443|:9000|:9100)'
```

Expected before moving on:

- Traefik is still listening on host `80/443`
- current service still shows `externalIPs: [100.90.167.160]`

## Phase 1: try the simplest solution

### Desired result

Traefik becomes a normal pod again, but the service still owns `100.90.167.160` as an `externalIP`.

Traffic path should become:

`NetBird peer -> 100.90.167.160:80/443 -> kube-proxy externalIPs rule -> Traefik service -> Traefik pod -> ingress -> ytdl service -> app pod`

### Replace `traefik-config.yaml`

Write this on the Pi to `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    deployment:
      replicas: 1
      strategy:
        type: Recreate
    service:
      type: ClusterIP
      externalIPs:
        - 100.90.167.160
```

What this intentionally removes:

- `hostNetwork: true`
- `dnsPolicy: ClusterFirstWithHostNet`
- low-port bind capability overrides
- custom pod security/bind settings that only existed to support host low ports

### Apply and wait

K3s should reconcile automatically after the file changes, but watch it:

```bash
kubectl -n kube-system rollout status deploy/traefik --timeout=180s
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
kubectl -n kube-system get svc traefik -o yaml
```

Expected results:

- Traefik pod gets a pod IP like `10.42.x.x`, not `192.168.1.105`
- service remains `ClusterIP`
- service still has `externalIPs: [100.90.167.160]`

### Validate listeners

Run:

```bash
sudo ss -ltnp | grep -E '(:80|:443|:9000|:9100)'
```

Expected results:

- nothing should be listening directly on host `:80` or `:443`
- Traefik may still expose dashboard/metrics internally depending on chart defaults, but not host low ports

### Validate from the Pi

Run:

```bash
getent hosts ytdl.mink.lan
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```

Expected result:

- both HTTPS requests return `HTTP/2 200` or at least a valid Traefik/TLS response for `ytdl.mink.lan`

### Validate from another NetBird peer

Run from another peer:

```bash
getent hosts ytdl.mink.lan
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```

Success criteria:

- DNS still resolves to `100.90.167.160`
- TLS handshake succeeds
- request returns the ytdl app response
- no host-level Traefik bind remains

## Phase 2: if Phase 1 works

Then the simpler solution is real, and you can keep it.

### Clean up the old low-port requirement

Because Traefik is no longer binding host low ports, the old sysctl should no longer be needed.

Check what set it:

```bash
grep -R "ip_unprivileged_port_start" /etc/sysctl.conf /etc/sysctl.d 2>/dev/null
```

Then remove that override and reload sysctl, or reboot when convenient.

Verify afterward:

```bash
sysctl net.ipv4.ip_unprivileged_port_start
```

Target value:

```text
net.ipv4.ip_unprivileged_port_start = 1024
```

Retest from a NetBird peer after changing it.

## Phase 3: fallback if Phase 1 fails

If Phase 1 breaks peer access, switch to the redirect design.

### Fallback design

- Traefik stays a normal pod
- Traefik service becomes `NodePort`
- fixed NodePorts used only for Traefik
- host nftables redirects only `wt0` traffic on `80/443`

### Recommended fallback NodePorts

Use these to avoid collision with `tuby` on `30080`:

- HTTP `32080`
- HTTPS `32443`

### Fallback `traefik-config.yaml`

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    deployment:
      replicas: 1
      strategy:
        type: Recreate
    service:
      type: NodePort
    ports:
      web:
        nodePort: 32080
      websecure:
        nodePort: 32443
```

### Fallback nftables rules

```bash
sudo nft add table inet traefik_wt0_redirect
sudo nft 'add chain inet traefik_wt0_redirect prerouting { type nat hook prerouting priority dstnat; policy accept; }'
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 80 redirect to :32080
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 443 redirect to :32443
```

Then retest from another NetBird peer.

## Rollback

If either experiment leaves Traefik inaccessible, restore the previous config:

```bash
sudo cp /var/lib/rancher/k3s/server/manifests/traefik-config.yaml.bak.TIMESTAMP /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
kubectl -n kube-system rollout status deploy/traefik --timeout=180s
```

If the fallback redirect rules were added, remove them too.

## What I want to see after Phase 1

Paste these back after the first attempt:

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
kubectl -n kube-system get svc traefik -o yaml
sudo ss -ltnp | grep -E '(:80|:443|:32080|:32443|:9000|:9100)'
curl -vkI https://ytdl.mink.lan/
```

and from another NetBird peer:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```
