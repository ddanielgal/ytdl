# NetBird -> Traefik pod DNAT debug

Goal: capture one failed remote request after DNAT to the Traefik pod and determine whether the packet dies on forward or on the return path.

Current known-good facts:

- Remote peer SYNs arrive on `wt0`.
- nft DNAT to Traefik pod `10.42.0.59:8443` matches.
- Pi-local access to `10.42.0.59:8000` and `10.42.0.59:8443` works.
- The remaining suspicion is reply-path / forwarding behavior for pod traffic back to the NetBird peer.

## Current DNAT state

Run on the Pi:

```bash
sudo nft list table inet traefik_wt0_dnat
```

Paste output here:

```text
```

## 1) Broad packet capture on the Pi

Open one terminal on the Pi and run:

```bash
sudo tcpdump -ni any '(host 100.90.149.44 and tcp) or (host 10.42.0.59 and tcp port 8443)'
```

Leave it running.

Paste output here after one peer-side test:

```text
```

## 2) nft packet trace

Open a second terminal on the Pi and run:

```bash
sudo nft monitor trace
```

Leave it running.

Paste output here after one peer-side test:

```text
```

## 3) Trigger exactly one remote test

From another NetBird peer, run exactly one request while both captures above are running:

```bash
curl -vkI https://ytdl.mink.lan/
```

Paste output here:

```text
```

## 4) Optional conntrack check

If `conntrack` is installed, run on the Pi:

```bash
sudo conntrack -L -p tcp | grep -E '100.90.149.44|10.42.0.59|8443'
```

If it is not installed, paste the error instead.

Paste output here:

```text
```

## 5) Temporary SNAT/MASQUERADE workaround test

If the request still hangs, add a postrouting SNAT rule so the Traefik pod sees node-side traffic instead of the original NetBird peer source.

Run on the Pi:

```bash
sudo nft 'add chain inet traefik_wt0_dnat postrouting { type nat hook postrouting priority srcnat; policy accept; }'
sudo nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr 10.42.0.59 tcp dport 8000 counter masquerade
sudo nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr 10.42.0.59 tcp dport 8443 counter masquerade
sudo nft list table inet traefik_wt0_dnat
```

Paste output here:

```text
```

## 6) Re-test after MASQUERADE

Run from the NetBird peer:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```

Paste output here:

```text
```

## 7) Check final counters

Run on the Pi:

```bash
sudo nft list table inet traefik_wt0_dnat
```

Paste output here:

```text
```

## Decision rule

- If `tcpdump` shows pod replies after MASQUERADE and curl succeeds, the issue is asymmetric return routing for pod traffic back to `wt0`.
- If DNAT matches but there is still no pod-side traffic on `any`, forwarding/filtering on the host is still the suspect.
- If `nft monitor trace` shows a drop chain, that chain is the next thing to fix.
- If MASQUERADE works, keep that as the temporary workaround and then decide whether to make it persistent or move back to a simpler host-bound Traefik design.
