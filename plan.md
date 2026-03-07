# Final networking playbook

Goal: keep Traefik close to normal K3s behavior and expose `ytdl.mink.lan` to NetBird peers with the smallest proven Pi-side fix.

Working traffic path:

`NetBird peer -> Pi wt0:80/443 -> host DNAT -> Traefik pod:8000/8443 -> host MASQUERADE on cni0 -> Traefik ingress -> Service/ytdl -> app pod`

Why this is the chosen fix:

- `externalIPs` did not work for real peer traffic.
- `NodePort` plus `wt0` redirect did not work for real peer traffic.
- direct DNAT to the Traefik pod worked only after adding:
  - a NetBird forward allow rule in `table ip netbird`
  - a pod-bound `MASQUERADE` rule on the Pi

## Target end state

- Traefik runs as a normal pod
- Traefik service is `ClusterIP`
- no `hostNetwork`
- no low-port bind workaround
- a Pi-local script reconciles the custom nftables and NetBird rules after boot/restart/pod-IP change

## Part 1: Inspect and back up the current Pi state

Run on the Pi before changing anything:

```bash
sudo mkdir -p /root/ytdl-netbird-backup
sudo cp /var/lib/rancher/k3s/server/manifests/traefik-config.yaml /root/ytdl-netbird-backup/traefik-config.yaml.bak.$(date +%F-%H%M%S)
sudo nft list ruleset > /root/ytdl-netbird-backup/nft-ruleset.$(date +%F-%H%M%S).txt
sudo iptables-save > /root/ytdl-netbird-backup/iptables-save.$(date +%F-%H%M%S).txt
sudo kubectl -n kube-system get svc traefik -o yaml > /root/ytdl-netbird-backup/traefik-svc.$(date +%F-%H%M%S).yaml
sudo kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide > /root/ytdl-netbird-backup/traefik-pods.$(date +%F-%H%M%S).txt
```

Verify the current live Traefik and NetBird state:

```bash
sudo kubectl -n kube-system get svc traefik -o wide
sudo kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo nft list table inet traefik_wt0_dnat
sudo nft -a list table ip netbird
```

## Part 2: Roll back old experiments

The objective here is to remove paths that are no longer needed.

### 2.1 Remove the old NodePort redirect table

If it still exists:

```bash
sudo nft list table inet traefik_wt0_redirect
sudo nft delete table inet traefik_wt0_redirect
```

If the delete says the table does not exist, that is fine.

### 2.2 Remove debug-only nftrace rules from the working DNAT table

List the table with handles:

```bash
sudo nft -a list table inet traefik_wt0_dnat
```

If you see rules like:

- `meta nftrace set 1`

delete them by handle, for example:

```bash
sudo nft delete rule inet traefik_wt0_dnat prerouting handle <HANDLE>
sudo nft delete rule inet traefik_wt0_dnat prerouting handle <HANDLE>
```

Then verify:

```bash
sudo nft -a list table inet traefik_wt0_dnat
```

### 2.3 Roll Traefik back toward defaults

Inspect the live override:

```bash
sudo sed -n '1,220p' /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
```

If it still contains host-bound workaround settings such as:

- `hostNetwork: true`
- `dnsPolicy: ClusterFirstWithHostNet`
- added `NET_BIND_SERVICE`
- pod security settings added only for low-port bind workaround

replace it with a minimal override that keeps Traefik on `ClusterIP` and otherwise close to packaged defaults:

```bash
sudo tee /var/lib/rancher/k3s/server/manifests/traefik-config.yaml >/dev/null <<'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      type: ClusterIP
EOF
```

Then wait for K3s to reconcile Traefik:

```bash
sudo kubectl -n kube-system rollout status deploy/traefik --timeout=180s
sudo kubectl -n kube-system get svc traefik -o wide
sudo kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
```

What you want to see:

- Traefik is running as a normal pod with a `10.42.x.x` pod IP
- Traefik service type is `ClusterIP`
- there is no host listener requirement from Traefik itself

### 2.4 Ignore NodePort unless it is still explicitly configured for Traefik

If Traefik is still `NodePort`, inspect the live override and remove the NodePort-specific settings from `traefik-config.yaml`.

Then re-check:

```bash
sudo kubectl -n kube-system get svc traefik -o wide
```

The target is:

- `TYPE: ClusterIP`

## Part 3: Install the durable host-side fix

The live manual rules worked, but they are not durable because:

- the Traefik pod IP can change
- `table ip netbird` is managed by NetBird and may be regenerated

So the durable fix is a small reconciliation script plus systemd.

### 3.1 Create the reconciliation script

Create `/usr/local/sbin/reconcile-ytdl-netbird.sh` on the Pi:

```bash
sudo tee /usr/local/sbin/reconcile-ytdl-netbird.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

WT0_IP="100.90.167.160"
TRAEFIK_SELECTOR='app.kubernetes.io/name=traefik'

TRAEFIK_POD_IP="$(kubectl -n kube-system get pods -l "$TRAEFIK_SELECTOR" -o jsonpath='{range .items[*]}{.status.phase}{" "}{.status.podIP}{"\n"}{end}' 2>/dev/null | awk '$1=="Running"{print $2; exit}')"

if [ -z "$TRAEFIK_POD_IP" ]; then
  echo "Could not determine Traefik pod IP" >&2
  exit 1
fi

echo "Using wt0 IP: $WT0_IP"
echo "Detected Traefik pod IP: $TRAEFIK_POD_IP"

# Recreate our dedicated DNAT table from scratch.
nft delete table inet traefik_wt0_dnat 2>/dev/null || true
nft add table inet traefik_wt0_dnat
nft 'add chain inet traefik_wt0_dnat prerouting { type nat hook prerouting priority -101; policy accept; }'
nft 'add chain inet traefik_wt0_dnat postrouting { type nat hook postrouting priority srcnat; policy accept; }'

nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr "$WT0_IP" tcp dport 80 counter dnat to "$TRAEFIK_POD_IP":8000
nft add rule inet traefik_wt0_dnat prerouting iifname "wt0" ip daddr "$WT0_IP" tcp dport 443 counter dnat to "$TRAEFIK_POD_IP":8443

nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr "$TRAEFIK_POD_IP" tcp dport 8000 counter masquerade
nft add rule inet traefik_wt0_dnat postrouting oifname "cni0" ip daddr "$TRAEFIK_POD_IP" tcp dport 8443 counter masquerade

echo "Rebuilt inet traefik_wt0_dnat for pod IP $TRAEFIK_POD_IP"

# Remove stale old Traefik pod accepts from the NetBird-managed forward chain.
for handle in $(nft -a list chain ip netbird netbird-rt-fwd | awk '/ip daddr 10\.42\..* tcp dport (8000|8443)/ {print $NF}'); do
  echo "Removing stale netbird-rt-fwd rule handle: $handle"
  nft delete rule ip netbird netbird-rt-fwd handle "$handle"
done

# Add fresh accepts for the current Traefik pod IP.
nft add rule ip netbird netbird-rt-fwd ip daddr "$TRAEFIK_POD_IP" tcp dport 8000 counter accept
nft add rule ip netbird netbird-rt-fwd ip daddr "$TRAEFIK_POD_IP" tcp dport 8443 counter accept

echo "Added netbird-rt-fwd accepts for $TRAEFIK_POD_IP:8000 and $TRAEFIK_POD_IP:8443"
echo "Final traefik_wt0_dnat table:"
nft list table inet traefik_wt0_dnat
echo "Final netbird-rt-fwd chain:"
nft -a list chain ip netbird netbird-rt-fwd
echo "Reconciled ytdl NetBird exposure to Traefik pod IP: $TRAEFIK_POD_IP"
EOF
```

Make it executable:

```bash
sudo chmod 755 /usr/local/sbin/reconcile-ytdl-netbird.sh
```

### 3.2 Test the script manually

Run:

```bash
sudo sed -n '1,240p' /usr/local/sbin/reconcile-ytdl-netbird.sh
sudo /usr/local/sbin/reconcile-ytdl-netbird.sh
sudo nft list table inet traefik_wt0_dnat
sudo nft -a list chain ip netbird netbird-rt-fwd
```

Verify the current Traefik pod IP matches the rules:

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
```

You want to see:

- `traefik_wt0_dnat` points to the current Traefik pod IP
- `netbird-rt-fwd` contains accepts for that same pod IP on `8000` and `8443`
- stale rules for old Traefik pod IPs are gone

### 3.3 Create a systemd oneshot service

Create `/etc/systemd/system/ytdl-netbird-reconcile.service`:

```bash
sudo tee /etc/systemd/system/ytdl-netbird-reconcile.service >/dev/null <<'EOF'
[Unit]
Description=Reconcile ytdl NetBird exposure rules
After=network-online.target k3s.service netbird.service
Wants=network-online.target
Requires=k3s.service netbird.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/reconcile-ytdl-netbird.sh

[Install]
WantedBy=multi-user.target
EOF
```

Reload systemd and enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ytdl-netbird-reconcile.service
sudo systemctl status ytdl-netbird-reconcile.service --no-pager
```

### 3.4 Re-run the reconcile service after NetBird restart

Because NetBird owns `table ip netbird`, it may recreate its rules and drop the manual accepts.

The simplest safe operational rule is:

- after any `netbird.service` restart, run the reconcile service again

Manual command:

```bash
sudo systemctl restart netbird
sudo systemctl start ytdl-netbird-reconcile.service
```

If you want this automated, add a NetBird drop-in that re-runs the reconcile service after NetBird starts.

Create `/etc/systemd/system/netbird.service.d/override.conf`:

```bash
sudo mkdir -p /etc/systemd/system/netbird.service.d
sudo tee /etc/systemd/system/netbird.service.d/override.conf >/dev/null <<'EOF'
[Unit]
Wants=ytdl-netbird-reconcile.service
After=ytdl-netbird-reconcile.service

[Service]
ExecStartPost=/bin/systemctl start ytdl-netbird-reconcile.service
EOF
```

Then reload systemd:

```bash
sudo systemctl daemon-reload
```

If you prefer less coupling, skip the drop-in and just re-run the reconcile service manually after NetBird changes.

## Part 4: Verify from the Pi and from a peer

### 4.1 Verify the live rule state on the Pi

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo nft list table inet traefik_wt0_dnat
sudo nft -a list table ip netbird
```

You want to see:

- DNAT rules to the current Traefik pod IP on ports `8000` and `8443`
- MASQUERADE rules for the same pod IP on `cni0`
- NetBird `netbird-rt-fwd` accepts for that same pod IP

### 4.2 Verify from another NetBird peer

```bash
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
curl -vkI --connect-timeout 2 --max-time 3 https://100.90.167.160/ -H 'Host: ytdl.mink.lan'
```

Expected result:

- `https://ytdl.mink.lan/` returns `HTTP/2 200` and the `ytdl.mink.lan` certificate
- `https://100.90.167.160/ -H 'Host: ytdl.mink.lan'` returns `HTTP/2 200` but will usually show the Traefik default certificate because SNI is the IP

## Part 5: Manual recovery if it breaks later

Use this after Traefik recreation, K3s restart, or NetBird restart.

### 5.1 Check whether the Traefik pod IP changed

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo nft list table inet traefik_wt0_dnat
sudo nft -a list table ip netbird
```

### 5.2 Re-run the reconcile script

```bash
sudo /usr/local/sbin/reconcile-ytdl-netbird.sh
```

or:

```bash
sudo systemctl start ytdl-netbird-reconcile.service
```

### 5.3 Re-test from a peer

```bash
curl -vkI --connect-timeout 2 --max-time 3 https://ytdl.mink.lan/
```

## Part 6: Roll back this whole custom host-side fix if needed

If you decide to abandon this design later:

### 6.1 Disable the reconcile service

```bash
sudo systemctl disable --now ytdl-netbird-reconcile.service
sudo rm -f /etc/systemd/system/ytdl-netbird-reconcile.service
sudo systemctl daemon-reload
```

### 6.2 Remove the reconcile script

```bash
sudo rm -f /usr/local/sbin/reconcile-ytdl-netbird.sh
```

### 6.3 Remove the custom DNAT table

```bash
sudo nft delete table inet traefik_wt0_dnat
```

### 6.4 Remove the manually added NetBird forward rules

List the table with handles:

```bash
sudo nft -a list table ip netbird
```

Delete only the manually added accepts for the Traefik pod by handle, for example:

```bash
sudo nft delete rule ip netbird netbird-rt-fwd handle <HANDLE_8000>
sudo nft delete rule ip netbird netbird-rt-fwd handle <HANDLE_8443>
```

### 6.5 Remove any NetBird systemd drop-in if you created one

```bash
sudo rm -f /etc/systemd/system/netbird.service.d/override.conf
sudo systemctl daemon-reload
```

### 6.6 Restore the previous Traefik override if needed

Choose the correct backup from `/root/ytdl-netbird-backup/` and restore it, for example:

```bash
sudo cp /root/ytdl-netbird-backup/traefik-config.yaml.bak.<TIMESTAMP> /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
sudo kubectl -n kube-system rollout status deploy/traefik --timeout=180s
```

## Notes

- The custom fix is intentionally scoped only to `wt0` traffic.
- LAN traffic on `eth0` is unaffected.
- The app PVC mount mismatch is still out of scope for this networking playbook.
