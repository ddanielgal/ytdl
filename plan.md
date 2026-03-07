# Final networking plan

Goal: keep Traefik close to default K3s behavior and expose `ytdl.mink.lan` to NetBird peers using the smallest targeted host-side fix that is known to work.

## Final design

- Traefik runs as a normal Kubernetes pod.
- Traefik service should be `ClusterIP`.
- NetBird DNS keeps resolving `ytdl.mink.lan` to the Pi `wt0` IP `100.90.167.160`.
- The Pi host handles `wt0` ingress with nftables DNAT and MASQUERADE.
- NetBird forward filtering explicitly allows the forwarded flow to the Traefik pod.

Working traffic path:

`NetBird peer -> wt0:80/443 -> host DNAT -> Traefik pod 8000/8443 -> host MASQUERADE on cni0 -> Traefik ingress -> ytdl service -> app pod`

## Why this is the chosen fix

- `externalIPs` did not work for real peer traffic.
- `NodePort` plus `wt0` redirect did not work for real peer traffic.
- `service ClusterIP` DNAT alone still failed because NetBird forward filtering blocked the forwarded packet.
- direct pod DNAT plus NetBird forward allow plus MASQUERADE is confirmed working.

## What to keep

- `Ingress/ytdl` and app service as-is
- Traefik as a normal pod
- TLS secret `ytdl-tls`
- NetBird DNS custom zone

## What to roll back

If any of these are still present in the live Pi config, remove them:

1. old NodePort redirect table
```bash
sudo nft delete table inet traefik_wt0_redirect
```

2. debug-only nftrace rules in `traefik_wt0_dnat`

3. Traefik host-bound workaround settings from `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`
   - `hostNetwork: true`
   - `dnsPolicy: ClusterFirstWithHostNet`
   - low-port bind capability additions used only for host port binding

4. failed service exposure experiments
   - `externalIPs: [100.90.167.160]`
   - Traefik `NodePort` exposure if it was added only for this debugging path

Preferred Traefik end state:

- normal pod networking
- service type `ClusterIP`
- no low-port host bind workaround

## Live working rule shape

The confirmed working live rules were:

```bash
sudo nft add table inet traefik_wt0_dnat
sudo nft 'add chain inet traefik_wt0_dnat prerouting { type nat hook prerouting priority -101; policy accept; }'
sudo nft 'add chain inet traefik_wt0_dnat postrouting { type nat hook postrouting priority srcnat; policy accept; }'

sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter dnat to <TRAEFIK_POD_IP>:8000
sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter dnat to <TRAEFIK_POD_IP>:8443

sudo nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr <TRAEFIK_POD_IP> tcp dport 8000 counter masquerade
sudo nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr <TRAEFIK_POD_IP> tcp dport 8443 counter masquerade

sudo nft add rule ip netbird netbird-rt-fwd ip daddr <TRAEFIK_POD_IP> tcp dport 8000 counter accept
sudo nft add rule ip netbird netbird-rt-fwd ip daddr <TRAEFIK_POD_IP> tcp dport 8443 counter accept
```

## Important caveat

This working rule set depends on the current Traefik pod IP.

- The pod IP can change when Traefik is recreated.
- `table ip netbird` is managed by NetBird, so manually added rules there may disappear on restart or upgrade.

Because of that, the right long-term solution is not manual nft commands. It is a small reconciliation script on the Pi.

## Persistence plan on the Pi

### 1) Normalize Traefik first

Make the live Traefik config as close to default as possible:

- remove `hostNetwork`
- remove host-network DNS policy override
- remove low-port bind capability workaround
- keep Traefik service as `ClusterIP`

### 2) Install a reconciliation script

Create a root-owned script on the Pi that:

1. gets the current Traefik pod IP
2. recreates `table inet traefik_wt0_dnat`
3. adds the DNAT rules for `wt0:80/443`
4. adds the `cni0` masquerade rules for the pod IP
5. ensures `table ip netbird` chain `netbird-rt-fwd` contains pod-port accepts for `8000` and `8443`

### 3) Run it with systemd

Use a oneshot service that runs after:

- `k3s.service`
- `netbird.service`

Also re-run it:

- on boot
- after NetBird restarts
- after Traefik pod recreation, if needed

### 4) Verify after each restart

Run:

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo nft list table inet traefik_wt0_dnat
sudo nft -a list table ip netbird
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
```

## Manual recovery procedure

If NetBird or Traefik restarts and access breaks, recover in this order:

1. get the current Traefik pod IP
```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
```

2. rebuild the custom DNAT table with the new pod IP

3. re-add the NetBird `netbird-rt-fwd` accept rules for the new pod IP

4. test from a peer
```bash
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
```

## Out of scope

- app PVC mount mismatch
- broader manifest cleanup unrelated to NetBird ingress
- replacing the self-signed cert workflow
