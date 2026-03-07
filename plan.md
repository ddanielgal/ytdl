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

Because the current Traefik pod owns host `80/443`, do an explicit down/up instead of relying on a rolling replacement. Downtime is acceptable here, and this avoids any bind conflict or rollout weirdness while moving away from `hostNetwork`.

```bash
kubectl -n kube-system scale deploy/traefik --replicas=0
kubectl -n kube-system wait --for=delete pod -l app.kubernetes.io/name=traefik -n kube-system --timeout=180s
kubectl -n kube-system scale deploy/traefik --replicas=1
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
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
openssl s_client -connect 100.90.167.160:443 -servername ytdl.mink.lan </dev/null
```

Expected result:

- if local DNS still works, `https://ytdl.mink.lan/` returns `HTTP/2 200`
- `--resolve` test should be the authoritative local test because it forces correct SNI for `ytdl.mink.lan`
- raw `https://100.90.167.160/ -H 'Host: ytdl.mink.lan'` is only a routing test; it may show the Traefik default cert and that is expected when connecting by IP


//// actual output
```text
den@pi:~$ getent hosts ytdl.mink.lan
den@pi:~$ curl -vkI https://ytdl.mink.lan/
* Could not resolve host: ytdl.mink.lan
* Closing connection
curl: (6) Could not resolve host: ytdl.mink.lan
den@pi:~$ curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
*   Trying 100.90.167.160:443...
* Connected to 100.90.167.160 (100.90.167.160) port 443
* ALPN: curl offers h2,http/1.1
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
* TLSv1.3 (IN), TLS handshake, Server hello (2):
* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):
* TLSv1.3 (IN), TLS handshake, Certificate (11):
* TLSv1.3 (IN), TLS handshake, CERT verify (15):
* TLSv1.3 (IN), TLS handshake, Finished (20):
* TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):
* TLSv1.3 (OUT), TLS handshake, Finished (20):
* SSL connection using TLSv1.3 / TLS_CHACHA20_POLY1305_SHA256 / X25519 / RSASSA-PSS
* ALPN: server accepted h2
* Server certificate:
*  subject: CN=TRAEFIK DEFAULT CERT
*  start date: Mar  7 09:51:08 2026 GMT
*  expire date: Mar  7 09:51:08 2027 GMT
*  issuer: CN=TRAEFIK DEFAULT CERT
*  SSL certificate verify result: self-signed certificate (18), continuing anyway.
*   Certificate level 0: Public key type RSA (2048/112 Bits/secBits), signed using sha256WithRSAEncryption
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* using HTTP/2
* [HTTP/2] [1] OPENED stream for https://100.90.167.160/
* [HTTP/2] [1] [:method: HEAD]
* [HTTP/2] [1] [:scheme: https]
* [HTTP/2] [1] [:authority: ytdl.mink.lan]
* [HTTP/2] [1] [:path: /]
* [HTTP/2] [1] [user-agent: curl/8.5.0]
* [HTTP/2] [1] [accept: */*]
> HEAD / HTTP/2
> Host: ytdl.mink.lan
> User-Agent: curl/8.5.0
> Accept: */*
>
< HTTP/2 200
HTTP/2 200
< content-type: text/html;charset=utf-8
content-type: text/html;charset=utf-8
< content-length: 401
content-length: 401
< date: Sat, 07 Mar 2026 09:53:37 GMT
date: Sat, 07 Mar 2026 09:53:37 GMT

<
* Connection #0 to host 100.90.167.160 left intact
```

Assessment of that output:

- This does **not** prove Phase 1 failed.
- It proves the routing path is alive: traffic to `100.90.167.160:443` still reaches Traefik and then the `ytdl` app, because the request returns `HTTP/2 200`.
- The `TRAEFIK DEFAULT CERT` is expected for the raw-IP curl test. TLS certificate selection happens during the handshake via SNI, before the HTTP `Host` header matters.
- The only actual problem shown so far is local Pi-side name resolution for `ytdl.mink.lan`, because `getent hosts` came back empty after the change.
- So the next decision point is **peer testing with proper hostname/SNI**, not immediate fallback.

### Validate from another NetBird peer

Run from another peer:

```bash
getent hosts ytdl.mink.lan
curl -vkI https://ytdl.mink.lan/
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
openssl s_client -connect 100.90.167.160:443 -servername ytdl.mink.lan </dev/null
```

Success criteria:

- DNS still resolves to `100.90.167.160`
- TLS handshake succeeds for the hostname/SNI-based tests
- request returns the ytdl app response
- no host-level Traefik bind remains

### What I think now

Based on the output already pasted, my current leaning is:

- the simpler `externalIPs` approach is probably working for real traffic
- the remaining issue is likely only local Pi DNS resolution, not Traefik ingress delivery
- do **not** fall back to redirects yet unless a real NetBird peer fails the hostname/SNI tests above

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
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
openssl s_client -connect 100.90.167.160:443 -servername ytdl.mink.lan </dev/null
```

and from another NetBird peer:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```
