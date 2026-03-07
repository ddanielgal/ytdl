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
den@pi:~$ kubectl -n kube-system get svc traefik -o wide
NAME      TYPE       CLUSTER-IP     EXTERNAL-IP   PORT(S)                      AGE    SELECTOR
traefik   NodePort   10.43.85.149   <none>        80:32080/TCP,443:32443/TCP   488d   app.kubernetes.io/instance=traefik-kube-system,app.kubernetes.io/name=traefik
den@pi:~$ kubectl -n kube-system get endpoints traefik -o wide
NAME      ENDPOINTS                         AGE
traefik   10.42.0.59:8000,10.42.0.59:8443   488d
den@pi:~$ kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
NAME                       READY   STATUS    RESTARTS   AGE   IP           NODE   NOMINATED NODE   READINESS GATES
traefik-665d467bdf-vkw7t   1/1     Running   0          22m   10.42.0.59   pi     <none>           <none>
den@pi:~$ sudo nft list table inet traefik_wt0_redirect
table inet traefik_wt0_redirect {
        chain prerouting {
                type nat hook prerouting priority dstnat - 1; policy accept;
                iifname "wt0" tcp dport 80 counter packets 0 bytes 0 redirect to :32080
                iifname "wt0" tcp dport 443 counter packets 9 bytes 540 redirect to :32443
        }
}
den@pi:~$ sudo nft list ruleset | grep -E '100.90.167.160|32080|32443|10\.43\.'
# Warning: table ip6 nat is managed by iptables-nft, do not touch!
# Warning: table ip nat is managed by iptables-nft, do not touch!
                ip daddr 10.43.181.51 ip protocol udp  udp dport 1900 counter packets 0 bytes 0 jump KUBE-SVC-5TL63OHMAKD6HCC7
                ip daddr 10.43.0.10 ip protocol tcp  tcp dport 9153 counter packets 0 bytes 0 jump KUBE-SVC-JD5MR3NA4I4DYORP
                ip daddr 10.43.0.10 ip protocol udp  udp dport 53 counter packets 24 bytes 2132 jump KUBE-SVC-TCOU7JCQXEZGVUNU
                ip daddr 10.43.11.157 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-I7ZLXZTKXA3L3TZN
                ip daddr 10.43.112.136 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-OSA2NXMW2NNWNEVJ
                ip daddr 10.43.0.10 ip protocol tcp  tcp dport 53 counter packets 0 bytes 0 jump KUBE-SVC-ERIFXISQEP7F7OF4
                ip daddr 10.43.63.99 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-WOUR72QKFKEYR5ZG
                ip daddr 10.43.85.149 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-UQMCRMJZLI3FTLDP
                ip daddr 10.43.85.149 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-SVC-CVG3OEGEH7H5P3HQ
                ip daddr 10.43.111.105 ip protocol tcp  tcp dport 6379 counter packets 0 bytes 0 jump KUBE-SVC-OKJCEJEOAS2LLIDR
                ip daddr 10.43.158.42 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-R462G7DIGADMZDEZ
                ip daddr 10.43.188.231 ip protocol tcp  tcp dport 5000 counter packets 0 bytes 0 jump KUBE-SVC-UHY5YTYXWYGJMWN5
                ip daddr 10.43.0.1 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-SVC-NPX46M4PTMTKRN6Y
                ip daddr 10.43.151.224 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-SVC-Z4ANX4WAEWEBLCTM
# Warning: XT target MASQUERADE not found
                ip protocol tcp  tcp dport 32080 counter packets 0 bytes 0 jump KUBE-EXT-UQMCRMJZLI3FTLDP
                ip protocol tcp  tcp dport 32443 counter packets 6 bytes 360 jump KUBE-EXT-CVG3OEGEH7H5P3HQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.10 ip protocol tcp  tcp dport 53 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.1 ip protocol tcp  tcp dport 443 counter packets 34 bytes 2040 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.10 ip protocol tcp  tcp dport 9153 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.10 ip protocol udp  udp dport 53 counter packets 198 bytes 16046 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
# Warning: XT target MASQUERADE not found
# Warning: XT target MASQUERADE not found
# Warning: XT target MASQUERADE not found
# Warning: XT target DNAT not found
                ip saddr != 10.42.0.0/16 ip daddr 10.43.151.224 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.188.231 ip protocol tcp  tcp dport 5000 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
                ip saddr != 10.42.0.0/16 ip daddr 10.43.111.105 ip protocol tcp  tcp dport 6379 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
                ip saddr != 10.42.0.0/16 ip daddr 10.43.158.42 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.181.51 ip protocol udp  udp dport 1900 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.11.157 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.112.136 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: XT target DNAT not found
# Warning: table ip6 filter is managed by iptables-nft, do not touch!
                ip saddr != 10.42.0.0/16 ip daddr 10.43.63.99 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.85.149 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip saddr != 10.42.0.0/16 ip daddr 10.43.85.149 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                iifname "wt0" tcp dport 80 counter packets 0 bytes 0 redirect to :32080
                iifname "wt0" tcp dport 443 counter packets 9 bytes 540 redirect to :32443
# Warning: table ip filter is managed by iptables-nft, do not touch!
                ip daddr 10.43.0.0/16  counter packets 0 bytes 0 return
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
den@pi:~$ sudo nft list table inet traefik_wt0_dnat
table inet traefik_wt0_dnat {
        chain prerouting {
                type nat hook prerouting priority dstnat - 1; policy accept;
                iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter packets 0 bytes 0 dnat ip to 10.43.85.149:80
                iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter packets 0 bytes 0 dnat ip to 10.43.85.149:443
        }
}
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
den@pi:~$ sudo tcpdump -ni wt0 'host 100.90.149.44 and (tcp port 80 or tcp port 443)'
tcpdump: verbose output suppressed, use -v[v]... for full protocol decode
listening on wt0, link-type RAW (Raw IP), snapshot length 262144 bytes
11:25:48.112086 IP 100.90.149.44.40918 > 100.90.167.160.443: Flags [S], seq 1220266320, win 64480, options [mss 1240,sackOK,TS val 2067382125 ecr 0,nop,wscale 10], length 0
11:25:49.162137 IP 100.90.149.44.40918 > 100.90.167.160.443: Flags [S], seq 1220266320, win 64480, options [mss 1240,sackOK,TS val 2067383176 ecr 0,nop,wscale 10], length 0
11:25:50.186191 IP 100.90.149.44.40918 > 100.90.167.160.443: Flags [S], seq 1220266320, win 64480, options [mss 1240,sackOK,TS val 2067384200 ecr 0,nop,wscale 10], length 0
11:25:54.400262 IP 100.90.149.44.40930 > 100.90.167.160.443: Flags [S], seq 997108188, win 64480, options [mss 1240,sackOK,TS val 2067388414 ecr 0,nop,wscale 10], length 0
11:25:55.434111 IP 100.90.149.44.40930 > 100.90.167.160.443: Flags [S], seq 997108188, win 64480, options [mss 1240,sackOK,TS val 2067389448 ecr 0,nop,wscale 10], length 0
11:25:57.832870 IP 100.90.149.44.60012 > 100.90.167.160.443: Flags [S], seq 281872586, win 64480, options [mss 1240,sackOK,TS val 2067391846 ecr 0,nop,wscale 10], length 0
11:25:58.890101 IP 100.90.149.44.60012 > 100.90.167.160.443: Flags [S], seq 281872586, win 64480, options [mss 1240,sackOK,TS val 2067392904 ecr 0,nop,wscale 10], length 0
^C
7 packets captured
7 packets received by filter
0 packets dropped by kernel
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
~ ❯ curl -vkI https://ytdl.mink.lan/

* Host ytdl.mink.lan:443 was resolved.
* IPv6: (none)
* IPv4: 100.90.167.160
*   Trying 100.90.167.160:443...
^C
~ ❯ curl -vkI --resolve ytdl.mink.lan:443:100.90.167.160 https://ytdl.mink.lan/

* Added ytdl.mink.lan:443:100.90.167.160 to DNS cache
* Hostname ytdl.mink.lan was found in DNS cache
*   Trying 100.90.167.160:443...
^C
~ ❯ curl -vkI https://100.90.167.160/ -H 'Host: ytdl.mink.lan'

*   Trying 100.90.167.160:443...
^C
```

## 6) Check nft counters after the peer tests

Run on the Pi:

```bash
sudo nft list table inet traefik_wt0_dnat
sudo iptables-save | grep -A20 -E 'KUBE-SERVICES|KUBE-SVC-|KUBE-EXT-'
```

Paste output here:

```text
table inet traefik_wt0_dnat {
        chain prerouting {
                type nat hook prerouting priority dstnat - 1; policy accept;
                iifname "wt0" ip daddr 100.90.167.160 tcp dport 80 counter packets 0 bytes 0 dnat ip to 10.43.85.149:80
                iifname "wt0" ip daddr 100.90.167.160 tcp dport 443 counter packets 3 bytes 180 dnat ip to 10.43.85.149:443
        }
}
den@pi:~$ sudo iptables-save | grep -A20 -E 'KUBE-SERVICES|KUBE-SVC-|KUBE-EXT-'
:KUBE-SERVICES - [0:0]
-A INPUT -m comment --comment "kube-router netpol - 4IA2OSFRMVNDXBVV" -j KUBE-ROUTER-INPUT
-A INPUT -i wt0 -j ACCEPT
-A INPUT -j KUBE-FIREWALL
-A INPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
-A INPUT -m comment --comment "kubernetes health check service ports" -j KUBE-NODEPORTS
-A INPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
-A INPUT -m comment --comment "KUBE-ROUTER rule to explicitly ACCEPT traffic that comply to network policies" -m mark --mark 0x20000/0x20000 -j ACCEPT
-A FORWARD -m comment --comment "kube-router netpol - TEMCG2JMHZYE7H7T" -j KUBE-ROUTER-FORWARD
-A FORWARD -o wt0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A FORWARD -i wt0 -j ACCEPT
-A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
-A FORWARD -m comment --comment "kubernetes forwarding rules" -j KUBE-FORWARD
-A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
-A FORWARD -m comment --comment "KUBE-ROUTER rule to explicitly ACCEPT traffic that comply to network policies" -m mark --mark 0x20000/0x20000 -j ACCEPT
-A FORWARD -m comment --comment "flanneld forward" -j FLANNEL-FWD
-A OUTPUT -m comment --comment "kube-router netpol - VEAAIY32XVBHCSCY" -j KUBE-ROUTER-OUTPUT
-A OUTPUT -j KUBE-FIREWALL
-A OUTPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
-A OUTPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A OUTPUT -m comment --comment "KUBE-ROUTER rule to explicitly ACCEPT traffic that comply to network policies" -m mark --mark 0x20000/0x20000 -j ACCEPT
-A FLANNEL-FWD -s 10.42.0.0/16 -m comment --comment "flanneld forward" -j ACCEPT
-A FLANNEL-FWD -d 10.42.0.0/16 -m comment --comment "flanneld forward" -j ACCEPT
-A KUBE-FIREWALL ! -s 127.0.0.0/8 -d 127.0.0.0/8 -m comment --comment "block incoming localnet connections" -m conntrack ! --ctstate RELATED,ESTABLISHED,DNAT -j DROP
-A KUBE-FORWARD -m conntrack --ctstate INVALID -j DROP
-A KUBE-FORWARD -m comment --comment "kubernetes forwarding rules" -m mark --mark 0x4000/0x4000 -j ACCEPT
-A KUBE-FORWARD -m comment --comment "kubernetes forwarding conntrack rule" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-NWPLCY-DEFAULT -p icmp -m comment --comment "allow icmp echo requests" -m icmp --icmp-type 8 -j ACCEPT
-A KUBE-NWPLCY-DEFAULT -p icmp -m comment --comment "allow icmp destination unreachable messages" -m icmp --icmp-type 3 -j ACCEPT
-A KUBE-NWPLCY-DEFAULT -p icmp -m comment --comment "allow icmp time exceeded messages" -m icmp --icmp-type 11 -j ACCEPT
-A KUBE-NWPLCY-DEFAULT -m comment --comment "rule to mark traffic matching a network policy" -j MARK --set-xmark 0x10000/0x10000
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -d 10.42.0.5/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -s 10.42.0.5/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -d 10.42.0.5/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -m comment --comment "rule to log dropped traffic POD name:metrics-server-cdcc87586-phckc namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -m comment --comment "rule to REJECT traffic destined for POD name:metrics-server-cdcc87586-phckc namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-24CAQJ4LYSAY3PHB -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
--
:KUBE-EXT-5TL63OHMAKD6HCC7 - [0:0]
:KUBE-EXT-CVG3OEGEH7H5P3HQ - [0:0]
:KUBE-EXT-R462G7DIGADMZDEZ - [0:0]
:KUBE-EXT-UHY5YTYXWYGJMWN5 - [0:0]
:KUBE-EXT-UQMCRMJZLI3FTLDP - [0:0]
:KUBE-KUBELET-CANARY - [0:0]
:KUBE-MARK-MASQ - [0:0]
:KUBE-NODEPORTS - [0:0]
:KUBE-POSTROUTING - [0:0]
:KUBE-PROXY-CANARY - [0:0]
:KUBE-SEP-2RAD5WKGWNVHY3DH - [0:0]
:KUBE-SEP-3OKKACDEVHSNJYBO - [0:0]
:KUBE-SEP-47TYL3K3JWJ36POJ - [0:0]
:KUBE-SEP-4SSQDR46DMIXOOUO - [0:0]
:KUBE-SEP-B5VO6EBO7JWDMZQ2 - [0:0]
:KUBE-SEP-EQF7TPGZGAONTLYZ - [0:0]
:KUBE-SEP-GP4EVLOCJ42DFVEM - [0:0]
:KUBE-SEP-IG67G5W4T7S4OGEE - [0:0]
:KUBE-SEP-OZMNHHTNYIHMU5QA - [0:0]
:KUBE-SEP-PQ2LHDKKDGM72FNX - [0:0]
:KUBE-SEP-SPW6OHKWQYLI5PJR - [0:0]
:KUBE-SEP-STZ7NNWKXWLGBLCX - [0:0]
:KUBE-SEP-TVJD5O64HPGUK6P4 - [0:0]
:KUBE-SEP-ZJH4LVE7MEUKNZQS - [0:0]
:KUBE-SERVICES - [0:0]
:KUBE-SVC-5TL63OHMAKD6HCC7 - [0:0]
:KUBE-SVC-CVG3OEGEH7H5P3HQ - [0:0]
:KUBE-SVC-ERIFXISQEP7F7OF4 - [0:0]
:KUBE-SVC-I7ZLXZTKXA3L3TZN - [0:0]
:KUBE-SVC-JD5MR3NA4I4DYORP - [0:0]
:KUBE-SVC-NPX46M4PTMTKRN6Y - [0:0]
:KUBE-SVC-OKJCEJEOAS2LLIDR - [0:0]
:KUBE-SVC-OSA2NXMW2NNWNEVJ - [0:0]
:KUBE-SVC-R462G7DIGADMZDEZ - [0:0]
:KUBE-SVC-TCOU7JCQXEZGVUNU - [0:0]
:KUBE-SVC-UHY5YTYXWYGJMWN5 - [0:0]
:KUBE-SVC-UQMCRMJZLI3FTLDP - [0:0]
:KUBE-SVC-WOUR72QKFKEYR5ZG - [0:0]
:KUBE-SVC-Z4ANX4WAEWEBLCTM - [0:0]
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A PREROUTING -m addrtype --dst-type LOCAL -j CNI-HOSTPORT-DNAT
-A OUTPUT -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A OUTPUT -m addrtype --dst-type LOCAL -j CNI-HOSTPORT-DNAT
-A POSTROUTING -m comment --comment "CNI portfwd requiring masquerade" -j CNI-HOSTPORT-MASQ
-A POSTROUTING -m comment --comment "kubernetes postrouting rules" -j KUBE-POSTROUTING
-A POSTROUTING -m comment --comment "flanneld masq" -j FLANNEL-POSTRTG
-A CNI-HOSTPORT-MASQ -m mark --mark 0x2000/0x2000 -j MASQUERADE
-A CNI-HOSTPORT-SETMARK -m comment --comment "CNI portfwd masquerade mark" -j MARK --set-xmark 0x2000/0x2000
-A FLANNEL-POSTRTG -m mark --mark 0x4000/0x4000 -m comment --comment "flanneld masq" -j RETURN
-A FLANNEL-POSTRTG -s 10.42.0.0/24 -d 10.42.0.0/16 -m comment --comment "flanneld masq" -j RETURN
-A FLANNEL-POSTRTG -s 10.42.0.0/16 -d 10.42.0.0/24 -m comment --comment "flanneld masq" -j RETURN
-A FLANNEL-POSTRTG ! -s 10.42.0.0/16 -d 10.42.0.0/24 -m comment --comment "flanneld masq" -j RETURN
-A FLANNEL-POSTRTG -s 10.42.0.0/16 ! -d 224.0.0.0/4 -m comment --comment "flanneld masq" -j MASQUERADE --random-fully
-A FLANNEL-POSTRTG ! -s 10.42.0.0/16 -d 10.42.0.0/16 -m comment --comment "flanneld masq" -j MASQUERADE --random-fully
-A KUBE-EXT-5TL63OHMAKD6HCC7 -m comment --comment "masquerade traffic for default/tuby-dlna:dlna-udp external destinations" -j KUBE-MARK-MASQ
-A KUBE-EXT-5TL63OHMAKD6HCC7 -j KUBE-SVC-5TL63OHMAKD6HCC7
-A KUBE-EXT-CVG3OEGEH7H5P3HQ -m comment --comment "masquerade traffic for kube-system/traefik:websecure external destinations" -j KUBE-MARK-MASQ
-A KUBE-EXT-CVG3OEGEH7H5P3HQ -j KUBE-SVC-CVG3OEGEH7H5P3HQ
-A KUBE-EXT-R462G7DIGADMZDEZ -m comment --comment "masquerade traffic for default/tuby:http external destinations" -j KUBE-MARK-MASQ
-A KUBE-EXT-R462G7DIGADMZDEZ -j KUBE-SVC-R462G7DIGADMZDEZ
-A KUBE-EXT-UHY5YTYXWYGJMWN5 -m comment --comment "masquerade traffic for default/registry external destinations" -j KUBE-MARK-MASQ
-A KUBE-EXT-UHY5YTYXWYGJMWN5 -j KUBE-SVC-UHY5YTYXWYGJMWN5
-A KUBE-EXT-UQMCRMJZLI3FTLDP -m comment --comment "masquerade traffic for kube-system/traefik:web external destinations" -j KUBE-MARK-MASQ
-A KUBE-EXT-UQMCRMJZLI3FTLDP -j KUBE-SVC-UQMCRMJZLI3FTLDP
-A KUBE-MARK-MASQ -j MARK --set-xmark 0x4000/0x4000
-A KUBE-NODEPORTS -p udp -m comment --comment "default/tuby-dlna:dlna-udp" -m udp --dport 32197 -j KUBE-EXT-5TL63OHMAKD6HCC7
-A KUBE-NODEPORTS -p tcp -m comment --comment "kube-system/traefik:web" -m tcp --dport 32080 -j KUBE-EXT-UQMCRMJZLI3FTLDP
-A KUBE-NODEPORTS -p tcp -m comment --comment "kube-system/traefik:websecure" -m tcp --dport 32443 -j KUBE-EXT-CVG3OEGEH7H5P3HQ
-A KUBE-NODEPORTS -p tcp -m comment --comment "default/tuby:http" -m tcp --dport 30080 -j KUBE-EXT-R462G7DIGADMZDEZ
-A KUBE-NODEPORTS -p tcp -m comment --comment "default/registry" -m tcp --dport 30500 -j KUBE-EXT-UHY5YTYXWYGJMWN5
-A KUBE-POSTROUTING -m mark ! --mark 0x4000/0x4000 -j RETURN
-A KUBE-POSTROUTING -j MARK --set-xmark 0x4000/0x0
-A KUBE-POSTROUTING -m comment --comment "kubernetes service traffic requiring SNAT" -j MASQUERADE --random-fully
-A KUBE-SEP-2RAD5WKGWNVHY3DH -s 10.42.0.7/32 -m comment --comment "kube-system/kube-dns:metrics" -j KUBE-MARK-MASQ
-A KUBE-SEP-2RAD5WKGWNVHY3DH -p tcp -m comment --comment "kube-system/kube-dns:metrics" -m tcp -j DNAT --to-destination 10.42.0.7:9153
-A KUBE-SEP-3OKKACDEVHSNJYBO -s 10.42.0.54/32 -m comment --comment "default/ytdl" -j KUBE-MARK-MASQ
-A KUBE-SEP-3OKKACDEVHSNJYBO -p tcp -m comment --comment "default/ytdl" -m tcp -j DNAT --to-destination 10.42.0.54:3000
-A KUBE-SEP-47TYL3K3JWJ36POJ -s 10.42.0.10/32 -m comment --comment "default/registry" -j KUBE-MARK-MASQ
-A KUBE-SEP-47TYL3K3JWJ36POJ -p tcp -m comment --comment "default/registry" -m tcp -j DNAT --to-destination 10.42.0.10:5000
-A KUBE-SEP-4SSQDR46DMIXOOUO -s 10.42.0.7/32 -m comment --comment "kube-system/kube-dns:dns" -j KUBE-MARK-MASQ
-A KUBE-SEP-4SSQDR46DMIXOOUO -p udp -m comment --comment "kube-system/kube-dns:dns" -m udp -j DNAT --to-destination 10.42.0.7:53
-A KUBE-SEP-B5VO6EBO7JWDMZQ2 -s 192.168.1.105/32 -m comment --comment "default/kubernetes:https" -j KUBE-MARK-MASQ
-A KUBE-SEP-B5VO6EBO7JWDMZQ2 -p tcp -m comment --comment "default/kubernetes:https" -m tcp -j DNAT --to-destination 192.168.1.105:6443
-A KUBE-SEP-EQF7TPGZGAONTLYZ -s 10.42.0.5/32 -m comment --comment "kube-system/metrics-server:https" -j KUBE-MARK-MASQ
-A KUBE-SEP-EQF7TPGZGAONTLYZ -p tcp -m comment --comment "kube-system/metrics-server:https" -m tcp -j DNAT --to-destination 10.42.0.5:10250
-A KUBE-SEP-GP4EVLOCJ42DFVEM -s 10.42.0.11/32 -m comment --comment "default/redis" -j KUBE-MARK-MASQ
-A KUBE-SEP-GP4EVLOCJ42DFVEM -p tcp -m comment --comment "default/redis" -m tcp -j DNAT --to-destination 10.42.0.11:6379
-A KUBE-SEP-IG67G5W4T7S4OGEE -s 10.42.0.32/32 -m comment --comment "default/sumnivore" -j KUBE-MARK-MASQ
-A KUBE-SEP-IG67G5W4T7S4OGEE -p tcp -m comment --comment "default/sumnivore" -m tcp -j DNAT --to-destination 10.42.0.32:3000
-A KUBE-SEP-OZMNHHTNYIHMU5QA -s 192.168.1.105/32 -m comment --comment "default/tuby:http" -j KUBE-MARK-MASQ
--
-A KUBE-SERVICES -d 10.43.181.51/32 -p udp -m comment --comment "default/tuby-dlna:dlna-udp cluster IP" -m udp --dport 1900 -j KUBE-SVC-5TL63OHMAKD6HCC7
-A KUBE-SERVICES -d 10.43.0.10/32 -p tcp -m comment --comment "kube-system/kube-dns:metrics cluster IP" -m tcp --dport 9153 -j KUBE-SVC-JD5MR3NA4I4DYORP
-A KUBE-SERVICES -d 10.43.0.10/32 -p udp -m comment --comment "kube-system/kube-dns:dns cluster IP" -m udp --dport 53 -j KUBE-SVC-TCOU7JCQXEZGVUNU
-A KUBE-SERVICES -d 10.43.11.157/32 -p tcp -m comment --comment "default/sumnivore cluster IP" -m tcp --dport 80 -j KUBE-SVC-I7ZLXZTKXA3L3TZN
-A KUBE-SERVICES -d 10.43.112.136/32 -p tcp -m comment --comment "default/sumnivore-bun cluster IP" -m tcp --dport 80 -j KUBE-SVC-OSA2NXMW2NNWNEVJ
-A KUBE-SERVICES -d 10.43.0.10/32 -p tcp -m comment --comment "kube-system/kube-dns:dns-tcp cluster IP" -m tcp --dport 53 -j KUBE-SVC-ERIFXISQEP7F7OF4
-A KUBE-SERVICES -d 10.43.63.99/32 -p tcp -m comment --comment "default/ytdl cluster IP" -m tcp --dport 80 -j KUBE-SVC-WOUR72QKFKEYR5ZG
-A KUBE-SERVICES -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:web cluster IP" -m tcp --dport 80 -j KUBE-SVC-UQMCRMJZLI3FTLDP
-A KUBE-SERVICES -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:websecure cluster IP" -m tcp --dport 443 -j KUBE-SVC-CVG3OEGEH7H5P3HQ
-A KUBE-SERVICES -d 10.43.111.105/32 -p tcp -m comment --comment "default/redis cluster IP" -m tcp --dport 6379 -j KUBE-SVC-OKJCEJEOAS2LLIDR
-A KUBE-SERVICES -d 10.43.158.42/32 -p tcp -m comment --comment "default/tuby:http cluster IP" -m tcp --dport 80 -j KUBE-SVC-R462G7DIGADMZDEZ
-A KUBE-SERVICES -d 10.43.188.231/32 -p tcp -m comment --comment "default/registry cluster IP" -m tcp --dport 5000 -j KUBE-SVC-UHY5YTYXWYGJMWN5
-A KUBE-SERVICES -d 10.43.0.1/32 -p tcp -m comment --comment "default/kubernetes:https cluster IP" -m tcp --dport 443 -j KUBE-SVC-NPX46M4PTMTKRN6Y
-A KUBE-SERVICES -d 10.43.151.224/32 -p tcp -m comment --comment "kube-system/metrics-server:https cluster IP" -m tcp --dport 443 -j KUBE-SVC-Z4ANX4WAEWEBLCTM
-A KUBE-SERVICES -m comment --comment "kubernetes service nodeports; NOTE: this must be the last rule in this chain" -m addrtype --dst-type LOCAL -j KUBE-NODEPORTS
-A KUBE-SVC-5TL63OHMAKD6HCC7 ! -s 10.42.0.0/16 -d 10.43.181.51/32 -p udp -m comment --comment "default/tuby-dlna:dlna-udp cluster IP" -m udp --dport 1900 -j KUBE-MARK-MASQ
-A KUBE-SVC-5TL63OHMAKD6HCC7 -m comment --comment "default/tuby-dlna:dlna-udp -> 192.168.1.105:1900" -j KUBE-SEP-PQ2LHDKKDGM72FNX
-A KUBE-SVC-CVG3OEGEH7H5P3HQ ! -s 10.42.0.0/16 -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:websecure cluster IP" -m tcp --dport 443 -j KUBE-MARK-MASQ
-A KUBE-SVC-CVG3OEGEH7H5P3HQ -m comment --comment "kube-system/traefik:websecure -> 10.42.0.59:8443" -j KUBE-SEP-ZJH4LVE7MEUKNZQS
-A KUBE-SVC-ERIFXISQEP7F7OF4 ! -s 10.42.0.0/16 -d 10.43.0.10/32 -p tcp -m comment --comment "kube-system/kube-dns:dns-tcp cluster IP" -m tcp --dport 53 -j KUBE-MARK-MASQ
-A KUBE-SVC-ERIFXISQEP7F7OF4 -m comment --comment "kube-system/kube-dns:dns-tcp -> 10.42.0.7:53" -j KUBE-SEP-SPW6OHKWQYLI5PJR
-A KUBE-SVC-I7ZLXZTKXA3L3TZN ! -s 10.42.0.0/16 -d 10.43.11.157/32 -p tcp -m comment --comment "default/sumnivore cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-I7ZLXZTKXA3L3TZN -m comment --comment "default/sumnivore -> 10.42.0.32:3000" -j KUBE-SEP-IG67G5W4T7S4OGEE
-A KUBE-SVC-JD5MR3NA4I4DYORP ! -s 10.42.0.0/16 -d 10.43.0.10/32 -p tcp -m comment --comment "kube-system/kube-dns:metrics cluster IP" -m tcp --dport 9153 -j KUBE-MARK-MASQ
-A KUBE-SVC-JD5MR3NA4I4DYORP -m comment --comment "kube-system/kube-dns:metrics -> 10.42.0.7:9153" -j KUBE-SEP-2RAD5WKGWNVHY3DH
-A KUBE-SVC-NPX46M4PTMTKRN6Y ! -s 10.42.0.0/16 -d 10.43.0.1/32 -p tcp -m comment --comment "default/kubernetes:https cluster IP" -m tcp --dport 443 -j KUBE-MARK-MASQ
-A KUBE-SVC-NPX46M4PTMTKRN6Y -m comment --comment "default/kubernetes:https -> 192.168.1.105:6443" -j KUBE-SEP-B5VO6EBO7JWDMZQ2
-A KUBE-SVC-OKJCEJEOAS2LLIDR ! -s 10.42.0.0/16 -d 10.43.111.105/32 -p tcp -m comment --comment "default/redis cluster IP" -m tcp --dport 6379 -j KUBE-MARK-MASQ
-A KUBE-SVC-OKJCEJEOAS2LLIDR -m comment --comment "default/redis -> 10.42.0.11:6379" -j KUBE-SEP-GP4EVLOCJ42DFVEM
-A KUBE-SVC-OSA2NXMW2NNWNEVJ ! -s 10.42.0.0/16 -d 10.43.112.136/32 -p tcp -m comment --comment "default/sumnivore-bun cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-OSA2NXMW2NNWNEVJ -m comment --comment "default/sumnivore-bun -> 10.42.0.29:3000" -j KUBE-SEP-TVJD5O64HPGUK6P4
-A KUBE-SVC-R462G7DIGADMZDEZ ! -s 10.42.0.0/16 -d 10.43.158.42/32 -p tcp -m comment --comment "default/tuby:http cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-R462G7DIGADMZDEZ -m comment --comment "default/tuby:http -> 192.168.1.105:8096" -j KUBE-SEP-OZMNHHTNYIHMU5QA
-A KUBE-SVC-TCOU7JCQXEZGVUNU ! -s 10.42.0.0/16 -d 10.43.0.10/32 -p udp -m comment --comment "kube-system/kube-dns:dns cluster IP" -m udp --dport 53 -j KUBE-MARK-MASQ
-A KUBE-SVC-TCOU7JCQXEZGVUNU -m comment --comment "kube-system/kube-dns:dns -> 10.42.0.7:53" -j KUBE-SEP-4SSQDR46DMIXOOUO
-A KUBE-SVC-UHY5YTYXWYGJMWN5 ! -s 10.42.0.0/16 -d 10.43.188.231/32 -p tcp -m comment --comment "default/registry cluster IP" -m tcp --dport 5000 -j KUBE-MARK-MASQ
-A KUBE-SVC-UHY5YTYXWYGJMWN5 -m comment --comment "default/registry -> 10.42.0.10:5000" -j KUBE-SEP-47TYL3K3JWJ36POJ
-A KUBE-SVC-UQMCRMJZLI3FTLDP ! -s 10.42.0.0/16 -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:web cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-UQMCRMJZLI3FTLDP -m comment --comment "kube-system/traefik:web -> 10.42.0.59:8000" -j KUBE-SEP-STZ7NNWKXWLGBLCX
-A KUBE-SVC-WOUR72QKFKEYR5ZG ! -s 10.42.0.0/16 -d 10.43.63.99/32 -p tcp -m comment --comment "default/ytdl cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-WOUR72QKFKEYR5ZG -m comment --comment "default/ytdl -> 10.42.0.54:3000" -j KUBE-SEP-3OKKACDEVHSNJYBO
-A KUBE-SVC-Z4ANX4WAEWEBLCTM ! -s 10.42.0.0/16 -d 10.43.151.224/32 -p tcp -m comment --comment "kube-system/metrics-server:https cluster IP" -m tcp --dport 443 -j KUBE-MARK-MASQ
-A KUBE-SVC-Z4ANX4WAEWEBLCTM -m comment --comment "kube-system/metrics-server:https -> 10.42.0.5:10250" -j KUBE-SEP-EQF7TPGZGAONTLYZ
COMMIT
# Completed on Sat Mar  7 11:27:48 2026
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
