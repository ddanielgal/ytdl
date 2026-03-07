# Traefik fallback debugging plan

Goal: figure out why NetBird peer traffic to `ytdl.mink.lan:443` is still failing even though:

- Traefik is a normal pod
- the Traefik service is `NodePort`
- local Pi tests to the NodePort work
- `wt0` redirect rules exist

Current theory: the failure is happening at the Pi host edge, before traffic is successfully handed off to the NodePort path for real remote peer traffic.

## What to run on the Pi

Open one terminal on the Pi for packet capture, and another for the static state commands.

### 1) Show redirect table and NodePort rules

Run:

```bash
sudo nft list table inet traefik_wt0_redirect
sudo iptables-save | grep -E '32080|32443'
sudo nft list ruleset | grep -E '32080|32443'
```

Paste output here:

```text
den@pi:~$ sudo nft list table inet traefik_wt0_redirect
table inet traefik_wt0_redirect {
        chain prerouting {
                type nat hook prerouting priority dstnat - 1; policy accept;
                iifname "wt0" tcp dport 80 counter packets 0 bytes 0 redirect to :32080
                iifname "wt0" tcp dport 443 counter packets 2 bytes 120 redirect to :32443
        }
}
den@pi:~$ sudo iptables-save | grep -E '32080|32443'
-A KUBE-NODEPORTS -p tcp -m comment --comment "kube-system/traefik:web" -m tcp --dport 32080 -j KUBE-EXT-UQMCRMJZLI3FTLDP
-A KUBE-NODEPORTS -p tcp -m comment --comment "kube-system/traefik:websecure" -m tcp --dport 32443 -j KUBE-EXT-CVG3OEGEH7H5P3HQ
den@pi:~$ sudo nft list ruleset | grep -E '32080|32443'
# Warning: table ip6 nat is managed by iptables-nft, do not touch!
# Warning: table ip nat is managed by iptables-nft, do not touch!
# Warning: XT target MASQUERADE not found
                ip protocol tcp  tcp dport 32080 counter packets 0 bytes 0 jump KUBE-EXT-UQMCRMJZLI3FTLDP
                ip protocol tcp  tcp dport 32443 counter packets 2 bytes 120 jump KUBE-EXT-CVG3OEGEH7H5P3HQ
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
                iifname "wt0" tcp dport 80 counter packets 0 bytes 0 redirect to :32080
                iifname "wt0" tcp dport 443 counter packets 2 bytes 120 redirect to :32443
# Warning: table ip filter is managed by iptables-nft, do not touch!
```

### 2) Watch incoming traffic on `wt0`

Run this and leave it running while you test from another NetBird peer:

```bash
sudo tcpdump -ni wt0 'tcp port 443 or tcp port 32443'
```

Paste output here after you run the peer-side tests below:

```text
den@pi:~$ sudo tcpdump -ni wt0 'tcp port 443 or tcp port 32443'
tcpdump: verbose output suppressed, use -v[v]... for full protocol decode
listening on wt0, link-type RAW (Raw IP), snapshot length 262144 bytes
11:17:20.783420 IP 100.90.149.44.37666 > 100.90.167.160.443: Flags [S], seq 3521301503, win 64480, options [mss 1240,sackOK,TS val 2066874797 ecr 0,nop,wscale 10], length 0
11:17:20.783640 IP 100.90.167.160.443 > 100.90.149.44.37666: Flags [R.], seq 0, ack 3521301504, win 0, length 0
11:17:24.282418 IP 100.90.149.44.43188 > 100.90.167.160.32443: Flags [S], seq 1585157304, win 64480, options [mss 1240,sackOK,TS val 2066878296 ecr 0,nop,wscale 10], length 0
11:17:25.290112 IP 100.90.149.44.43188 > 100.90.167.160.32443: Flags [S], seq 1585157304, win 64480, options [mss 1240,sackOK,TS val 2066879304 ecr 0,nop,wscale 10], length 0
11:17:26.314204 IP 100.90.149.44.43188 > 100.90.167.160.32443: Flags [S], seq 1585157304, win 64480, options [mss 1240,sackOK,TS val 2066880328 ecr 0,nop,wscale 10], length 0
11:17:27.338160 IP 100.90.149.44.43188 > 100.90.167.160.32443: Flags [S], seq 1585157304, win 64480, options [mss 1240,sackOK,TS val 2066881352 ecr 0,nop,wscale 10], length 0
```

### 3) Optional: watch any interface for the same ports

If the `wt0` capture is inconclusive, also try:

```bash
sudo tcpdump -ni any 'tcp port 443 or tcp port 32443'
```

Paste output here:

```text
(spam)
```

## What to run from another NetBird peer

While the Pi `tcpdump` is running, execute these:

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'
```

Paste output here:

```text
~ ❯ curl -vkI https://ytdl.mink.lan/        11:16:14

* Host ytdl.mink.lan:443 was resolved.
* IPv6: (none)
* IPv4: 100.90.167.160
*   Trying 100.90.167.160:443...
* connect to 100.90.167.160 port 443 from 100.90.149.44 port 37666 failed: Connection refused
* Failed to connect to ytdl.mink.lan port 443 after 1 ms: Could not connect to server
* closing connection #0
curl: (7) Failed to connect to ytdl.mink.lan port 443 after 1 ms: Could not connect to server
~ ❯ curl -vkI https://100.90.167.160:32443/ -H 'Host: ytdl.mink.lan'

*   Trying 100.90.167.160:32443...
^C
```

## What I will determine from the outputs

These checks will tell us which of these is true:

- peer traffic reaches `wt0:443` but never gets redirected
- peer traffic is redirected to `32443` but the NodePort path still rejects it
- peer traffic reaches `32443` and then fails later in kube-proxy/service routing
- the issue is specific to `wt0` vs `any` interface handling

## Decision rule after this round

- If `443` packets appear on `wt0` but no `32443` packets appear, the redirect rule is not matching or not rewriting the way we expect.
- If `32443` packets appear and the peer still gets `Connection refused`, the NodePort path itself is not usable for remote NetBird traffic.
- If direct peer access to `100.90.167.160:32443` works but `443` does not, the redirect rule is the only remaining issue.

Once you paste the outputs, I can tell you whether to:

1. change the nft redirect rule shape again, or
2. stop targeting the NodePort and DNAT directly to the Traefik pod/service path instead
