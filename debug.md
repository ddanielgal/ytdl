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
den@pi:~$ sudo nft list table inet traefik_wt0_dnat
table inet traefik_wt0_dnat {
        chain prerouting {
                type nat hook prerouting priority dstnat - 1; policy accept;
                iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter packets 0 bytes 0 dnat ip to 10.42.0.59:8000
                iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter packets 12 bytes 720 dnat ip to 10.42.0.59:8443
                iifname "wt0" ip saddr 100.90.149.44 tcp dport 443 meta nftrace set 1
                iifname "wt0" ip saddr 100.90.149.44 tcp dport 443 meta nftrace set 1
        }
}
```

## 1) Broad packet capture on the Pi

Open one terminal on the Pi and run:

```bash
sudo tcpdump -ni any '(host 100.90.149.44 and tcp) or (host 10.42.0.59 and tcp port 8443)'
```

Leave it running.

Paste output here after one peer-side test:

```text
den@pi:~$ sudo tcpdump -ni any '(host 100.90.149.44 and tcp) or (host 10.42.0.59 and tcp port 8443)'
tcpdump: data link type LINUX_SLL2
tcpdump: verbose output suppressed, use -v[v]... for full protocol decode
listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 262144 bytes
11:56:42.358147 wt0   In  IP 100.90.149.44.40726 > 100.90.167.160.443: Flags [S], seq 92043686, win 64480, options [mss 1240,sackOK,TS val 2069236373 ecr 0,nop,wscale 10], length 0
11:56:43.368235 wt0   In  IP 100.90.149.44.40726 > 100.90.167.160.443: Flags [S], seq 92043686, win 64480, options [mss 1240,sackOK,TS val 2069237384 ecr 0,nop,wscale 10], length 0
^C
2 packets captured
4 packets received by filter
0 packets dropped by kernel
```

## 2) nft packet trace

Open a second terminal on the Pi and run:

```bash
sudo nft monitor trace
```

Leave it running.

Paste output here after one peer-side test:

```text
den@pi:~$ sudo nft monitor trace
^C
```

//// no output on nft monitor trace while firing a peer curl

## 3) Trigger exactly one remote test

From another NetBird peer, run exactly one request while both captures above are running:

```bash
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
```

Paste output here:

```text
~/projects/ytdl bun ⇡15 !1 ❯ curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/

* Host ytdl.mink.lan:443 was resolved.
* IPv6: (none)
* IPv4: 100.90.167.160
*   Trying 100.90.167.160:443...
* Connection timed out after 2002 milliseconds
* closing connection #0
curl: (28) Connection timed out after 2002 milliseconds
```

## 4) Optional conntrack check

If `conntrack` is installed, run on the Pi:

```bash
sudo conntrack -L -p tcp | grep -E '100.90.149.44|10.42.0.59|8443'
```

If it is not installed, paste the error instead.

Paste output here:

```text
den@pi:~$ sudo conntrack -L -p tcp | grep -E '100.90.149.44|10.42.0.59|8443'
tcp      6 107 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=53526 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=53526 [ASSURED] mark=0 use=1
tcp      6 77 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=53772 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=53772 [ASSURED] mark=0 use=1
tcp      6 77 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=53774 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=53774 [ASSURED] mark=0 use=1
tcp      6 97 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=35620 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=35620 [ASSURED] mark=0 use=1
tcp      6 37 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=48548 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=48548 [ASSURED] mark=0 use=1
tcp      6 27 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=43914 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=43914 [ASSURED] mark=0 use=1
tcp      6 27 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=43916 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=43916 [ASSURED] mark=0 use=1
tcp      6 117 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=45462 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=45462 [ASSURED] mark=0 use=1
tcp      6 17 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=41080 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=41080 [ASSURED] mark=0 use=1
tcp      6 117 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=45450 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=45450 [ASSURED] mark=0 use=1
tcp      6 67 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=52996 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=52996 [ASSURED] mark=0 use=1
tcp      6 7 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=37684 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=37684 [ASSURED] mark=0 use=1
tcp      6 17 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=41082 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=41082 [ASSURED] mark=0 use=1
tcp      6 37 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=48546 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=48546 [ASSURED] mark=0 use=1
tcp      6 47 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=34800 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=34800 [ASSURED] mark=0 use=1
tcp      6 97 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=35618 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=35618 [ASSURED] mark=0 use=1
tcp      6 87 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=42398 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=42398 [ASSURED] mark=0 use=1
tcp      6 7 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=37682 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=37682 [ASSURED] mark=0 use=1
tcp      6 87 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=42388 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=42388 [ASSURED] mark=0 use=1
tcp      6 67 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=52994 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=52994 [ASSURED] mark=0 use=1
tcp      6 57 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=60634 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=60634 [ASSURED] mark=0 use=1
tcp      6 47 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=34802 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=34802 [ASSURED] mark=0 use=1
tcp      6 107 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=53528 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=53528 [ASSURED] mark=0 use=1
tcp      6 57 TIME_WAIT src=10.42.0.1 dst=10.42.0.59 sport=60636 dport=9000 src=10.42.0.59 dst=10.42.0.1 sport=9000 dport=60636 [ASSURED] mark=0 use=1
tcp      6 86399 ESTABLISHED src=10.42.0.59 dst=10.43.0.1 sport=46832 dport=443 src=192.168.1.105 dst=10.42.0.59 sport=6443 dport=46832 [ASSURED] mark=0 use=1
conntrack v1.4.8 (conntrack-tools): 143 flow entries have been shown.
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
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
curl -vkI --connect-timeout 2 --max-time 3 https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
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
