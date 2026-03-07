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

//// actual
```text
den@pi:~$ kubectl -n kube-system get svc traefik -o yaml
apiVersion: v1
kind: Service
metadata:
  annotations:
    meta.helm.sh/release-name: traefik
    meta.helm.sh/release-namespace: kube-system
  creationTimestamp: "2024-11-03T13:06:30Z"
  labels:
    app.kubernetes.io/instance: traefik-kube-system
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/name: traefik
    helm.sh/chart: traefik-27.0.201_up27.0.2
  name: traefik
  namespace: kube-system
  resourceVersion: "33750930"
  uid: 293c7e84-e5ec-49b3-ae90-bc8f8d7476b6
spec:
  clusterIP: 10.43.85.149
  clusterIPs:
  - 10.43.85.149
  externalTrafficPolicy: Cluster
  internalTrafficPolicy: Cluster
  ipFamilies:
  - IPv4
  ipFamilyPolicy: PreferDualStack
  ports:
  - name: web
    nodePort: 32080
    port: 80
    protocol: TCP
    targetPort: web
  - name: websecure
    nodePort: 32443
    port: 443
    protocol: TCP
    targetPort: websecure
  selector:
    app.kubernetes.io/instance: traefik-kube-system
    app.kubernetes.io/name: traefik
  sessionAffinity: None
  type: NodePort
status:
  loadBalancer: {}
```

Assessment:

- Yes, this looks right.
- The rendered Traefik service is now `NodePort`.
- The NodePorts are exactly `32080` and `32443`.
- So K3s did pick up your override.

About the file path:

- `/var/lib/rancher/k3s/server/manifests/traefik.yaml` is the packaged K3s `HelmChart` manifest.
- `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml` is the correct place for your `HelmChartConfig` override.
- In K3s, the override file is merged into the packaged chart values at install/reconcile time.
- So you normally edit `traefik-config.yaml`, not `traefik.yaml`.

How to verify that K3s is using the override:

```bash
sudo sed -n '1,220p' /var/lib/rancher/k3s/server/manifests/traefik.yaml
sudo sed -n '1,220p' /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
kubectl -n kube-system get helmchart traefik -o yaml
kubectl -n kube-system get helmchartconfig traefik -o yaml
kubectl -n kube-system get svc traefik -o yaml
```

The best proof is the rendered service output you already pasted: if the service is `NodePort` with `32080` and `32443`, then the override is active.

## 3) Add the `wt0` redirect rules

Run:

```bash
sudo nft add table inet traefik_wt0_redirect
sudo nft 'add chain inet traefik_wt0_redirect prerouting { type nat hook prerouting priority dstnat; policy accept; }'
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 80 redirect to :32080
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 443 redirect to :32443
```

These rules affect only traffic entering on `wt0`.

Important: the redirect chain should run **before** kube-proxy's own `dstnat` handling, otherwise the packet may still be processed as plain `:443` traffic and get refused. Use an earlier priority than `dstnat`.

Use this version instead:

```bash
sudo nft delete table inet traefik_wt0_redirect 2>/dev/null || true
sudo nft add table inet traefik_wt0_redirect
sudo nft 'add chain inet traefik_wt0_redirect prerouting { type nat hook prerouting priority -101; policy accept; }'
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 80 counter redirect to :32080
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 443 counter redirect to :32443
```

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

//// actual

```text
den@pi:~$ kubectl -n kube-system get svc traefik -o yaml
apiVersion: v1
kind: Service
metadata:
  annotations:
    meta.helm.sh/release-name: traefik
    meta.helm.sh/release-namespace: kube-system
  creationTimestamp: "2024-11-03T13:06:30Z"
  labels:
    app.kubernetes.io/instance: traefik-kube-system
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/name: traefik
    helm.sh/chart: traefik-27.0.201_up27.0.2
  name: traefik
  namespace: kube-system
  resourceVersion: "33750930"
  uid: 293c7e84-e5ec-49b3-ae90-bc8f8d7476b6
spec:
  clusterIP: 10.43.85.149
  clusterIPs:
  - 10.43.85.149
  externalTrafficPolicy: Cluster
  internalTrafficPolicy: Cluster
  ipFamilies:
  - IPv4
  ipFamilyPolicy: PreferDualStack
  ports:
  - name: web
    nodePort: 32080
    port: 80
    protocol: TCP
    targetPort: web
  - name: websecure
    nodePort: 32443
    port: 443
    protocol: TCP
    targetPort: websecure
  selector:
    app.kubernetes.io/instance: traefik-kube-system
    app.kubernetes.io/name: traefik
  sessionAffinity: None
  type: NodePort
status:
  loadBalancer: {}
den@pi:~$ kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
NAME                       READY   STATUS    RESTARTS   AGE     IP           NODE   NOMINATED NODE   READINESS GATES
traefik-665d467bdf-vkw7t   1/1     Running   0          3m32s   10.42.0.59   pi     <none>           <none>
den@pi:~$ sudo ss -ltnp | grep -E '(:80|:443|:32080|:32443|:9000|:9100)'
LISTEN 0      128          0.0.0.0:44322      0.0.0.0:*    users:(("pmproxy",pid=1091,fd=13))             
LISTEN 0      128          0.0.0.0:44323      0.0.0.0:*    users:(("pmproxy",pid=1091,fd=15))             
LISTEN 0      5            0.0.0.0:44321      0.0.0.0:*    users:(("pmcd",pid=1053,fd=0))                 
LISTEN 0      512          0.0.0.0:8096       0.0.0.0:*    users:(("jellyfin",pid=7827,fd=498))           
LISTEN 0      4096            [::]:44369         [::]:*    users:(("rpc.statd",pid=1008,fd=11))           
LISTEN 0      128             [::]:44322         [::]:*    users:(("pmproxy",pid=1091,fd=14))             
LISTEN 0      128             [::]:44323         [::]:*    users:(("pmproxy",pid=1091,fd=16))             
LISTEN 0      5               [::]:44321         [::]:*    users:(("pmcd",pid=1053,fd=3))                 
den@pi:~$ sudo nft list ruleset | sed -n '/traefik_wt0_redirect/,+20p'
# Warning: table ip6 nat is managed by iptables-nft, do not touch!
# Warning: table ip nat is managed by iptables-nft, do not touch!
# Warning: XT target MASQUERADE not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target MASQUERADE not found
# Warning: XT target MASQUERADE not found
# Warning: XT target MASQUERADE not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: table ip6 filter is managed by iptables-nft, do not touch!
# Warning: table ip filter is managed by iptables-nft, do not touch!
table inet traefik_wt0_redirect {
        chain prerouting {
                type nat hook prerouting priority dstnat; policy accept;
                iifname "wt0" tcp dport 80 redirect to :32080
                iifname "wt0" tcp dport 443 redirect to :32443
        }
}
den@pi:~$ curl -vkI https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'
*   Trying 100.90.167.160:32443...
* Connected to 100.90.167.160 (100.90.167.160) port 32443
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
*  start date: Mar  7 10:00:21 2026 GMT
*  expire date: Mar  7 10:00:21 2027 GMT
*  issuer: CN=TRAEFIK DEFAULT CERT
*  SSL certificate verify result: self-signed certificate (18), continuing anyway.
*   Certificate level 0: Public key type RSA (2048/112 Bits/secBits), signed using sha256WithRSAEncryption
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* using HTTP/2
* [HTTP/2] [1] OPENED stream for https://100.90.167.160:32443/
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
< date: Sat, 07 Mar 2026 10:04:20 GMT
date: Sat, 07 Mar 2026 10:04:20 GMT

<
* Connection #0 to host 100.90.167.160 left intact
```

Assessment:

- The NodePort side is healthy.
- The redirect table exists, but the external peer still gets `Connection refused` on `:443`.
- `Connection refused` means the peer reaches the Pi, but the redirect is not taking effect in the right place for real `wt0` traffic.
- The most likely cause is hook ordering: your custom redirect chain currently uses `priority dstnat`, which collides with kube-proxy's own nat handling.
- The fix is to recreate the redirect chain with an **earlier** priority, such as `-101`, so the packet is rewritten to `32443` before kube-proxy evaluates NodePorts.

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

//// actual

```text
~ ❯ getent hosts ytdl.mink.lan              10:57:13

100.90.167.160  ytdl.mink.lan
~ ❯ curl -vkI https://ytdl.mink.lan/        11:07:24

* Host ytdl.mink.lan:443 was resolved.
* IPv6: (none)
* IPv4: 100.90.167.160
*   Trying 100.90.167.160:443...
* connect to 100.90.167.160 port 443 from 100.90.149.44 port 41138 failed: Connection refused
* Failed to connect to ytdl.mink.lan port 443 after 1 ms: Could not connect to server
* closing connection #0
curl: (7) Failed to connect to ytdl.mink.lan port 443 after 1 ms: Could not connect to server
~ ❯ curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/

* Added ytdl.mink.lan:443:100.90.167.160 to DNS cache
* Hostname ytdl.mink.lan was found in DNS cache
*   Trying 100.90.167.160:443...
* connect to 100.90.167.160 port 443 from 100.90.149.44 port 57882 failed: Connection refused
* Failed to connect to ytdl.mink.lan port 443 after 1 ms: Could not connect to server
* closing connection #0
curl: (7) Failed to connect to ytdl.mink.lan port 443 after 1 ms: Could not connect to server
~ ❯ openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null

C06046CB14760000:error:8000006F:system library:BIO_connect:Connection refused:crypto/bio/bio_sock2.c:178:calling connect()
C06046CB14760000:error:10000067:BIO routines:BIO_connect:connect error:crypto/bio/bio_sock2.c:180:
connect:errno=111
```

Verdict:

- DNS is correct.
- Traefik NodePort is correct.
- The current redirect rules are not yet correct for remote peer traffic.
- Next step: recreate the nft redirect chain with `priority -101`, then retest.

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

## Next step

On the Pi, replace the redirect table with the earlier-priority version:

```bash
sudo nft delete table inet traefik_wt0_redirect
sudo nft add table inet traefik_wt0_redirect
sudo nft 'add chain inet traefik_wt0_redirect prerouting { type nat hook prerouting priority -101; policy accept; }'
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 80 counter redirect to :32080
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 443 counter redirect to :32443
sudo nft list table inet traefik_wt0_redirect
```

Then from another NetBird peer run again:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```
