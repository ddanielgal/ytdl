# ytdl deployment and networking research

## Repo topology

### App topology

- `k8s/app.yml` defines the user-facing app:
  - `Deployment/ytdl`, 1 replica
  - container image `pi.home:30500/ddanielgal/ytdl:latest`
  - container port `3000`
  - `Service/ytdl` exposes port `80 -> 3000`
  - `Ingress/ytdl` uses `ingressClassName: traefik`
  - host is `ytdl.mink.lan`
  - TLS secret is `ytdl-tls`
- `server.ts` confirms the app is a Bun server listening on `PORT` or `3000`.

Declared traffic path:

`client -> Traefik ingress -> Service/ytdl:80 -> app pod:3000`

### Queue and worker topology

- `k8s/redis.yml` defines Redis as an in-cluster dependency.
- `k8s/app.yml` injects `REDIS_HOST=redis` and `REDIS_PORT=6379`.
- `src/lib/queue.ts` uses BullMQ on Redis.
- `k8s/worker.yml` defines `Deployment/ytdl-worker`.
- `src/worker/worker.ts` confirms the worker runs `yt-dlp` jobs.

### Storage topology

- `k8s/pvc.yml` defines `PVC/ytdlq` and `PVC/redis` on `nfs-storage`.
- `k8s/worker.yml` mounts `ytdlq` at `/app/data`.
- `src/worker/worker.ts` writes downloads under `data/videos/...`.

### TLS and DNS assumptions

- Public name is `ytdl.mink.lan`.
- TLS terminates at Traefik with secret `ytdl-tls`.
- `scripts/create-ytdl-tls-secret.sh` generates a self-signed cert for this private deployment model.
- NetBird custom DNS for `mink.lan` maps `ytdl.mink.lan` to the Pi NetBird IP.

### Separate functional gap still present

- The app code reads local `data/` for `listVideos`.
- `k8s/app.yml` does not mount the `ytdlq` PVC into the app pod.
- That is unrelated to the ingress fix, but is still a likely runtime mismatch.

## Final networking findings

### What was confirmed

- NetBird DNS resolution is correct: `ytdl.mink.lan -> 100.90.167.160`.
- Peer traffic reaches the Pi on `wt0`.
- Traefik ingress routing is healthy once traffic reaches Traefik.
- Pi-local direct access to the Traefik pod works:
  - `http://10.42.0.59:8000/` with `Host: ytdl.mink.lan` returns `200`
  - `https://10.42.0.59:8443/` with `Host: ytdl.mink.lan` returns `200`

### What was ruled out

- `ClusterIP + externalIPs` on the Traefik service was not sufficient for real peer traffic.
- `NodePort` plus `wt0` redirect to `32080/32443` was not sufficient either.
- DNAT to the Traefik service ClusterIP still did not work until NetBird forwarding was explicitly allowed.

### Root cause

The real blocker was not Traefik itself. It was the host/network path for forwarded NetBird traffic:

- host DNAT from `wt0:443` to Traefik was required
- NetBird's nftables forward filter dropped the forwarded packet unless `table ip netbird`, chain `netbird-rt-fwd`, explicitly accepted it
- the pod-bound flow also needed SNAT/MASQUERADE on the Pi so reply traffic returned correctly to the NetBird peer

In short, the successful path is:

`NetBird peer -> Pi wt0:443 -> host DNAT -> Traefik pod:8443 -> host MASQUERADE for pod-bound flow -> Traefik ingress -> ytdl service -> app pod`

## Confirmed working live fix

The working targeted fix used three pieces:

1. Host DNAT for `wt0` traffic to the Traefik pod
2. Host MASQUERADE for the pod-bound flow on `cni0`
3. NetBird forward allow rule in `table ip netbird`, chain `netbird-rt-fwd`

Observed working rules:

```bash
sudo nft add table inet traefik_wt0_dnat
sudo nft 'add chain inet traefik_wt0_dnat prerouting { type nat hook prerouting priority -101; policy accept; }'
sudo nft 'add chain inet traefik_wt0_dnat postrouting { type nat hook postrouting priority srcnat; policy accept; }'

sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter dnat to 10.42.0.59:8000
sudo nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter dnat to 10.42.0.59:8443

sudo nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr 10.42.0.59 tcp dport 8000 counter masquerade
sudo nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr 10.42.0.59 tcp dport 8443 counter masquerade

sudo nft add rule ip netbird netbird-rt-fwd ip daddr 10.42.0.59 tcp dport 8000 counter accept
sudo nft add rule ip netbird netbird-rt-fwd ip daddr 10.42.0.59 tcp dport 8443 counter accept
```

With those rules active:

- `curl -vkI https://ytdl.mink.lan/` from another NetBird peer returned `HTTP/2 200`
- the peer saw the proper `ytdl.mink.lan` certificate when connecting by hostname
- `curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'` also returned `HTTP/2 200`, but with the Traefik default cert as expected because SNI was the IP, not the hostname

## Simplified target design

Keep as much as possible close to normal K3s/Traefik behavior and scope the custom logic only to the `wt0` ingress edge.

### Keep

- Traefik as a normal Kubernetes pod, not `hostNetwork`
- normal Traefik pod ports `8000` and `8443`
- Kubernetes ingress and service routing for the app unchanged
- NetBird DNS mapping `ytdl.mink.lan -> 100.90.167.160`

### Customize only at the Pi edge

- DNAT only traffic arriving on `wt0` for `80/443`
- MASQUERADE only the pod-bound `cni0` traffic for that DNATed flow
- allow only the Traefik pod ports in NetBird forward rules

### Important operational caveat

The confirmed working fix targets the current Traefik pod IP directly (`10.42.0.59`). That is operationally simple, but not stable across Traefik pod recreation.

So the durable version should not be a one-time manual nft edit. It should be a small reconciliation script on the Pi that:

- discovers the current Traefik pod IP
- rewrites the custom DNAT/MASQUERADE table with that IP
- re-inserts the required NetBird forward accept rules for that IP

## What is no longer necessary

These earlier paths can now be considered dead ends for this setup:

- Traefik `hostNetwork: true`
- low-port capability workarounds such as `NET_BIND_SERVICE`
- low-port sysctl workarounds such as `net.ipv4.ip_unprivileged_port_start=0`
- `ClusterIP + externalIPs: [100.90.167.160]` as the exposure mechanism
- `NodePort` plus `wt0` redirect to `32080/32443`

## Rollback and cleanup guidance

If the working DNAT + NetBird-forward fix is the chosen path, roll back old experiments so only the targeted fix remains.

### Remove old NodePort redirect attempt

If present:

```bash
sudo nft delete table inet traefik_wt0_redirect
```

### Remove debug-only nftrace rules

If present in `traefik_wt0_dnat`, remove the extra `meta nftrace set 1` rules.

### Remove old Traefik exposure experiments

If still present in the live Traefik config, remove:

- `hostNetwork: true`
- `dnsPolicy: ClusterFirstWithHostNet`
- explicit low-port bind security capability additions for this networking workaround
- any `externalIPs: [100.90.167.160]` used for the failed service exposure path
- `NodePort` exposure for Traefik if it was added only for this debugging path

Preferred end state for Traefik is:

- normal pod networking
- service type `ClusterIP`
- no special low-port host binding behavior

### Why this rollback is safe

The actual exposure no longer depends on Traefik binding host ports or on kube-proxy NodePort behavior. It depends on host nftables DNAT plus the NetBird forward allow.

## NetBird package behavior and persistence caveat

This matters a lot:

- `table ip netbird` is managed by the NetBird package/daemon
- the manually inserted `netbird-rt-fwd` accept rules are therefore not trustworthy as a permanent static change
- they may be lost on NetBird restart, upgrade, or ruleset refresh

Because of that, the NetBird accept rule should be treated as a reconciled change, not a one-time manual edit.

## Recommended persistence approach on the Pi

Use a small root-owned reconciliation script plus systemd.

### Script responsibilities

On each run, the script should:

1. get the current Traefik pod IP from Kubernetes
2. recreate or replace `table inet traefik_wt0_dnat`
3. add:
   - `wt0:80 -> <traefik-pod-ip>:8000`
   - `wt0:443 -> <traefik-pod-ip>:8443`
4. add:
   - `oifname cni0 daddr <traefik-pod-ip> tcp dport 8000 masquerade`
   - `oifname cni0 daddr <traefik-pod-ip> tcp dport 8443 masquerade`
5. ensure `table ip netbird` chain `netbird-rt-fwd` contains accept rules for:
   - `<traefik-pod-ip>:8000`
   - `<traefik-pod-ip>:8443`

### systemd recommendation

Run that script from a dedicated oneshot service that starts after both:

- `netbird.service`
- `k3s.service`

and also on boot.

Because NetBird owns its own table, a periodic timer or an additional rerun on NetBird restart is also sensible.

### Why not rely on plain `nftables.conf` alone

Static nft rules are not enough by themselves because:

- the Traefik pod IP can change
- the NetBird-managed table can be regenerated

So persistence needs a small amount of discovery and re-application logic.

## Recommended final direction

For this deployment, the cleanest practical model is:

- Traefik stays a normal K3s-managed pod
- Traefik service goes back to `ClusterIP`
- the Pi owns a small custom `wt0` DNAT/MASQUERADE ruleset
- a Pi-local reconciliation script re-applies the NetBird forward accept and updates the Traefik pod IP when needed

That keeps Kubernetes and Traefik mostly default, and keeps the custom networking localized to the one place that actually needs to know about NetBird: the Pi host edge.
