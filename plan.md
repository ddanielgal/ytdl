# Traefik next-round plan: DNAT `wt0` traffic to the Traefik service

Goal: replace the failed `wt0 -> NodePort` approach with a simpler host NAT rule that sends NetBird peer traffic for `ytdl.mink.lan` straight into the Traefik Kubernetes service path.

## What we know now

- Peer traffic to `100.90.167.160:443` reaches the Pi on `wt0`.
- The nft redirect rule from `443 -> 32443` matches.
- The kube-proxy NodePort rule for `32443` also matches.
- Direct peer traffic to `100.90.167.160:32443` still hangs.
- Conclusion: the NodePort path is not a good target for remote NetBird peer traffic here.

## New target design

Use host nftables DNAT only for traffic arriving on `wt0`:

- `wt0 tcp/80 -> Traefik service ClusterIP:80`
- `wt0 tcp/443 -> Traefik service ClusterIP:443`

This keeps Traefik as a normal Kubernetes workload and avoids:

- `hostNetwork: true`
- low-port bind capabilities
- NodePort for the NetBird ingress path

## Recommended approach

DNAT to the Traefik service ClusterIP first, not directly to the pod IP.

Why:

- the service ClusterIP is the stable Kubernetes frontend
- kube-proxy can still choose the backing endpoint
- the rule does not need to change when the Traefik pod IP changes

Only fall back to direct pod-IP DNAT if service-IP DNAT still fails.

## 1) Capture current state before changing anything

Run on the Pi:

```bash
sudo kubectl -n kube-system get svc traefik -o wide
sudo kubectl -n kube-system get endpoints traefik -o wide
sudo kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo nft list table inet traefik_wt0_redirect
sudo nft list ruleset | grep -E '100.90.167.160|32080|32443|10\.43\.'
```

Paste output here:

```text
```

## 2) Remove the old NodePort redirect rules

Run on the Pi:

```bash
sudo nft delete table inet traefik_wt0_redirect
```

If that table does not exist anymore, paste the error too.

Paste output here:

```text
```

## 3) Create the new `wt0` DNAT rules to the Traefik service ClusterIP

First get the current Traefik service ClusterIP:

```bash
sudo kubectl -n kube-system get svc traefik -o jsonpath='{.spec.clusterIP}'
```

Then create the DNAT table and rules. Replace `10.43.85.149` below if the service IP is different.

```bash
sudo nft add table inet traefik_wt0_dnat
sudo nft 'add chain inet traefik_wt0_dnat prerouting { type nat hook prerouting priority -101; policy accept; }'
sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter dnat to 10.43.85.149:80
sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter dnat to 10.43.85.149:443
sudo nft list table inet traefik_wt0_dnat
```

Paste output here:

```text
```

## 4) Watch the traffic path while testing

Open one terminal on the Pi for packet capture.

### Primary capture

```bash
sudo tcpdump -ni wt0 'host 100.90.149.44 and (tcp port 80 or tcp port 443)'
```

### Secondary capture

In another terminal, also run:

```bash
sudo tcpdump -ni any 'host 100.90.149.44 and (tcp port 80 or tcp port 443)'
```

Optional if you want to see whether traffic reaches the in-cluster side:

```bash
sudo tcpdump -ni cni0 'tcp'
```

Paste output here:

```text
```

## 5) Test from another NetBird peer

Run from the peer while the Pi captures are running:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```

Paste output here:

```text
```

## 6) Check nft counters after the peer tests

Run on the Pi:

```bash
sudo nft list table inet traefik_wt0_dnat
sudo iptables-save | grep -A20 -E 'KUBE-SERVICES|KUBE-SVC-|KUBE-EXT-'
```

Paste output here:

```text
```

## Decision rule

- If the DNAT counters increase and the peer gets HTTP/TLS response, this design works.
- If the DNAT counters increase but the peer still hangs, the service-IP path still is not completing; next fallback is DNAT directly to the current Traefik pod IP.
- If the DNAT counters do not increase, the match is wrong; check `iifname`, destination IP, and nft hook priority.
- If `https://100.90.167.160/ -H 'Host: ytdl.mink.lan'` works from the peer, DNS and Traefik routing are fine and the host NAT path is solved.

## If service-IP DNAT fails: final fallback

Use the current Traefik pod IP from:

```bash
sudo kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
```

Then replace the service-IP DNAT rules with pod-IP DNAT rules:

```bash
sudo nft flush chain inet traefik_wt0_dnat prerouting
sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter dnat to <TRAEFIK_POD_IP>:80
sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter dnat to <TRAEFIK_POD_IP>:443
sudo nft list table inet traefik_wt0_dnat
```

Only use this if the service-IP version fails, because the pod IP is not stable.

## Expected end state if this works

- Traefik stays a normal pod
- Traefik service can remain `ClusterIP`
- NetBird peers reach `https://ytdl.mink.lan/` via `wt0`
- no `hostNetwork: true`
- no low-port capability workaround

## Out of scope for this round

- app PVC mount drift
- non-networking manifest cleanup
- broader Traefik chart cleanup beyond the access path needed for `ytdl.mink.lan`
