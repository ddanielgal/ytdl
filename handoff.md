Use this as the handoff context for the next session:
We are debugging K3s/Traefik + NetBird exposure for the `ytdl` app in `/home/den/projects/ytdl`.
Repo/manifests:
- App ingress host is `ytdl.mink.lan`
- Traefik is the ingress class
- TLS is via secret `ytdl-tls`
- NetBird custom DNS zone resolves `ytdl.mink.lan` to the Pi NetBird IP `100.90.167.160`
What happened historically:
- Default-ish K3s Traefik/ServiceLB (`svclb`) did not properly serve traffic arriving on `wt0`
- I worked around it by making Traefik bind host `80/443` directly with `hostNetwork: true`
- That worked, but required low-port bind handling (`NET_BIND_SERVICE` / `ip_unprivileged_port_start=0`)
What we tried:
1. Simpler attempt: keep Traefik as normal pod, `ClusterIP`, `externalIPs: [100.90.167.160]`
- Result: local Pi-originated requests to `100.90.167.160` worked
- Real traffic from another NetBird peer failed/hung
- Conclusion: `ClusterIP + externalIPs` is not viable for the real peer traffic path here
2. Fallback attempt: Traefik as `NodePort`
- `web` nodePort = `32080`
- `websecure` nodePort = `32443`
- Traefik pod is normal pod now, not hostNetwork
- `kubectl get svc -n kube-system traefik -o yaml` showed correct NodePort config
- No process is listening on host `:80` or `:443`, which is expected because NodePort is implemented by kube-proxy/nftables, not a userspace socket
- On the Pi, direct test to `https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'` returned HTTP 200 (with Traefik default cert, expected because connecting by IP)
What we then tried:
- Added nftables redirect rules on the Pi so only `wt0` traffic is redirected:
  - `wt0 tcp dport 80 -> 32080`
  - `wt0 tcp dport 443 -> 32443`
- First used `priority dstnat`
- Then retried with earlier `priority -101`
Current problem:
- From another NetBird peer, `https://ytdl.mink.lan/` still fails with immediate `Connection refused`
- Same for `--resolve ytdl.mink.lan:443:100.90.167.160`
- So peer traffic reaches the Pi, but the redirect/NodePort path is still not functioning for remote `wt0` traffic
- We do not yet know whether:
  - the nft redirect is not matching remote packets, or
  - the redirect matches, but remote access to the NodePort path is itself refused
Important known-good facts:
- DNS is correct from peers: `ytdl.mink.lan -> 100.90.167.160`
- Traefik ingress/service/app routing is healthy once traffic gets there
- Traefik NodePort config is active and correct
- Pi-local direct NodePort access works
- Real remote NetBird peer access to `443` still fails
Files in repo:
- `research.md` contains the broader deployment/networking investigation and prior outputs
- `plan.md` was reset to a clean debugging plan with commands to run next
Current next diagnostic step:
- On the Pi:
  - `sudo nft list table inet traefik_wt0_redirect`
  - `sudo iptables-save | grep -E '32080|32443'`
  - `sudo nft list ruleset | grep -E '32080|32443'`
  - run `sudo tcpdump -ni wt0 'tcp port 443 or tcp port 32443'`
  - optionally `sudo tcpdump -ni any 'tcp port 443 or tcp port 32443'`
- From another NetBird peer while tcpdump runs:
  - `curl -vkI https://ytdl.mink.lan/`
  - `curl -vkI https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'`
Decision rule:
- If tcpdump shows `443` but never `32443`, nft redirect is not matching/rewrite path is wrong
- If tcpdump shows `32443` and peer still gets refused, remote NodePort path itself is unusable
- If direct peer access to `:32443` works but `:443` does not, only the redirect rule is broken
Notes:
- Ignore manifest drift and the app PVC mount issue for now; that is out of scope for this networking initiative
- `traefik-config.yaml` is the correct K3s override file, not `traefik.yaml`
Also tell the next agent to read plan.md and research.md first.
