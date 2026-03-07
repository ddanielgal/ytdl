# Install

This is the shortest path to get this app running on a Raspberry Pi from scratch with `k3s`, Traefik, and NetBird.

For networking background and why the host-side NetBird rules exist, see `docs/networking.md`.

## Assumptions

- Raspberry Pi already has Linux installed.
- The Pi is joined to your NetBird network.
- Other NetBird peers should reach this app at `ytdl.mink.lan`.
- Your cluster has a storage class named `nfs-storage`.
- The container image in `k8s/app.yml` and `k8s/worker.yml` exists in a registry your Pi can pull from.

## 1. Clone the repo on the Pi

```bash
git clone <repo-url>
cd ytdl
```

## 2. Install `k3s` and NetBird

Install `k3s` using the standard K3s install method, and install/join NetBird using your usual NetBird setup flow.

After both are installed, verify:

```bash
sudo k3s kubectl get nodes
ip addr show wt0
sudo nft list table ip netbird
```

## 3. Keep Traefik as a normal `ClusterIP` service

Create or replace `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`:

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
sudo k3s kubectl -n kube-system rollout status deploy/traefik --timeout=180s
```

## 4. Create the TLS secret for `ytdl.mink.lan`

```bash
./scripts/create-ytdl-tls-secret.sh
```

That creates a self-signed certificate and stores it in the `ytdl-tls` secret in the default namespace. Trust the generated `.crt` on client devices if you want the browser warning to go away.

## 5. Apply the Kubernetes manifests

```bash
sudo k3s kubectl apply -f k8s/pvc.yml
sudo k3s kubectl apply -f k8s/redis.yml
sudo k3s kubectl apply -f k8s/app.yml
sudo k3s kubectl apply -f k8s/worker.yml
```

Check rollout:

```bash
sudo k3s kubectl get pods,svc,ingress
sudo k3s kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
```

## 6. Configure NetBird DNS

In NetBird, make sure `ytdl.mink.lan` resolves for your peers to the Pi's NetBird IP on `wt0`.

Example:

- `ytdl.mink.lan -> 100.x.y.z`

## 7. Install the host-side NetBird reconcile files

Copy the repo files onto the Pi system paths:

```bash
sudo install -m 755 k8s/reconcile-ytdl-netbird.sh /usr/local/sbin/reconcile-ytdl-netbird.sh
sudo install -m 644 k8s/ytdl-netbird-reconcile.service /etc/systemd/system/ytdl-netbird-reconcile.service
```

Create `/etc/default/ytdl-netbird-reconcile` with your Pi's NetBird IP:

```bash
sudo tee /etc/default/ytdl-netbird-reconcile >/dev/null <<'EOF'
WT0_IP=100.x.y.z
EOF
```

The script and systemd unit live in the repo here:

- `k8s/reconcile-ytdl-netbird.sh`
- `k8s/ytdl-netbird-reconcile.service`

## 8. Enable and run the reconcile service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ytdl-netbird-reconcile.service
sudo systemctl status ytdl-netbird-reconcile.service --no-pager
```

That service:

- finds the current Traefik pod IP
- DNATs NetBird `80/443` traffic on `wt0` to Traefik `8000/8443`
- adds the required MASQUERADE rules on `cni0`
- re-adds the needed NetBird forward allow rules

## 9. Verify from another NetBird peer

```bash
curl -vkI https://ytdl.mink.lan/
curl -vkI https://100.x.y.z/ -H 'Host: ytdl.mink.lan'
```

Expected:

- `https://ytdl.mink.lan/` returns `HTTP/2 200`
- the hostname request shows the `ytdl.mink.lan` certificate
- the direct IP test may show Traefik's default certificate because SNI is the IP

## 10. Day-2 operations

If Traefik is recreated or NetBird restarts, rerun:

```bash
sudo systemctl start ytdl-netbird-reconcile.service
```

Useful checks:

```bash
sudo k3s kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide
sudo nft list table inet ytdl_wt0_dnat
sudo nft -a list chain ip netbird netbird-rt-fwd
```

## Notes

- This setup intentionally keeps Traefik on normal pod networking.
- The NetBird-specific customization is only on the Pi host.
- There is still a separate app/storage issue to solve later: the app deployment does not currently mount the same PVC that the worker writes to.
