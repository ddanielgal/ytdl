# Traefik fallback plan

Goal: keep Traefik off `hostNetwork`, stop binding host `80/443`, and expose `ytdl.mink.lan` to NetBird peers by redirecting only `wt0` traffic to Traefik NodePorts.

This is the recommended path because the simpler `ClusterIP + externalIPs` attempt worked locally on the Pi but failed for real peer traffic.

## Target design

- Traefik runs as a normal pod
- Traefik service is `NodePort`
- fixed NodePorts:
  - HTTP `32080`
  - HTTPS `32443`
- host nftables redirects only `wt0` traffic:
  - `wt0:80 -> 32080`
  - `wt0:443 -> 32443`

Traffic path:

`NetBird peer -> wt0:80/443 -> nftables redirect -> Traefik NodePort -> Traefik pod -> ingress -> ytdl service -> app pod`

## 1) Update Traefik config on the Pi

Write this to `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`:

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

This intentionally does **not** use `hostNetwork`, and it avoids collision with `tuby` on `30080`.

## 2) Restart Traefik cleanly

Run:

```bash
kubectl -n kube-system scale deploy/traefik --replicas=0
kubectl -n kube-system wait --for=delete pod -l app.kubernetes.io/name=traefik -n kube-system --timeout=180s
kubectl -n kube-system scale deploy/traefik --replicas=1
kubectl -n kube-system rollout status deploy/traefik --timeout=180s
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
kubectl -n kube-system get svc traefik -o yaml
```

Expected:

- Traefik pod has a pod IP like `10.42.x.x`
- service is `NodePort`
- NodePorts are exactly `32080` and `32443`
- nothing is listening directly on host `:80` or `:443`

## 3) Add the `wt0` redirect rules

Run:

```bash
sudo nft add table inet traefik_wt0_redirect
sudo nft 'add chain inet traefik_wt0_redirect prerouting { type nat hook prerouting priority dstnat; policy accept; }'
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 80 redirect to :32080
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 443 redirect to :32443
```

These rules affect only traffic entering on `wt0`.

## 4) Validate on the Pi

Run:

```bash
kubectl -n kube-system get svc traefik -o yaml
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo ss -ltnp | grep -E '(:80|:443|:32080|:32443|:9000|:9100)'
sudo nft list ruleset | sed -n '/traefik_wt0_redirect/,+20p'
curl -vkI https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'
```

What to expect:

- service shows `32080` and `32443`
- no process listens on host `:80` or `:443`
- nft rules are present
- direct NodePort test reaches Traefik/app

## 5) Validate from another NetBird peer

Run:

```bash
getent hosts ytdl.mink.lan
curl -vkI https://ytdl.mink.lan/
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```

Success means:

- DNS resolves to `100.90.167.160`
- TLS handshake succeeds promptly
- cert for the hostname/SNI path is `CN=ytdl.mink.lan`
- request returns the ytdl app response

## 6) What to paste back

From the Pi:

```bash
kubectl -n kube-system get svc traefik -o yaml
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo ss -ltnp | grep -E '(:80|:443|:32080|:32443|:9000|:9100)'
sudo nft list ruleset | sed -n '/traefik_wt0_redirect/,+20p'
```

From another NetBird peer:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```
