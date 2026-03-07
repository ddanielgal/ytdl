# NetBird forward-chain debug

Goal: verify whether NetBird's nftables forward path is dropping the DNATed traffic before it ever leaves the host toward the Traefik pod.

What we already know:

- Remote peer SYNs reach `wt0`.
- DNAT to `10.42.0.59:8443` matches and its counter rises.
- No packets show up for `10.42.0.59:8443` in the broad `tcpdump`.
- The DNAT table `postrouting` masquerade rule stays at `0`.
- That means the packet is dying before postrouting, most likely in forward filtering.
- The strongest suspect is the NetBird nftables table `inet netbird_wt0`.

## 1) Show the full NetBird table before testing

Run on the Pi:

```bash
sudo nft list table inet netbird_wt0
```

Paste output here:

```text
```

## 2) Reset NetBird table counters

Run on the Pi:

```bash
sudo nft reset counters table inet netbird_wt0
sudo nft list table inet netbird_wt0
```

Paste output here:

```text
```

## 3) Run exactly one peer request with current rules

From another NetBird peer, run:

```bash
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
```

Paste output here:

```text
```

## 4) Inspect NetBird counters after the failed request

Run on the Pi:

```bash
sudo nft list table inet netbird_wt0
```

Paste output here:

```text
```

## 5) Temporary allow rule for the Traefik pod

If the request still fails, insert temporary forward accept rules for the Traefik pod.

Run on the Pi:

```bash
sudo nft insert rule inet netbird_wt0 netbird-rt-fwd ip daddr 10.42.0.59 tcp dport 8443 counter accept
sudo nft insert rule inet netbird_wt0 netbird-rt-fwd ip daddr 10.42.0.59 tcp dport 8000 counter accept
sudo nft list table inet netbird_wt0
```

Paste output here:

```text
```

## 6) Re-test from the peer after the temporary allow rule

From another NetBird peer, run:

```bash
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
curl -vkI --connect-timeout 2 --max-time 3 https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```

Paste output here:

```text
```

## 7) Inspect NetBird counters again

Run on the Pi:

```bash
sudo nft list table inet netbird_wt0
```

Paste output here:

```text
```

## 8) Optional packet capture during the allow-rule test

If needed, run this on the Pi while the peer curl runs:

```bash
sudo tcpdump -ni any '(host 100.90.149.44 and tcp) or (host 10.42.0.59 and tcp port 8443)'
```

Paste output here:

```text
```

## Decision rule

- If the temporary `netbird-rt-fwd` allow rule makes the request work, NetBird's forward filtering is the blocker.
- If the allow rule counter increases but curl still fails, the packet is getting further and the next suspect is reply-path handling.
- If the allow rule counter stays at `0`, either the wrong NetBird chain is involved or the packet is being dropped even earlier.
- If traffic to `10.42.0.59:8443` finally appears in `tcpdump`, the forward block is solved and the next focus is return traffic.

## Cleanup note

If the temporary allow rule is only for testing, remove it later after we confirm the root cause. Do not remove it yet until we have the result.
