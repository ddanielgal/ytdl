# ytdl deployment and networking research

## What the repo says today

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
- The app serves the frontend and tRPC API, but not downloads directly.

Traffic, as declared in the manifests:

`client -> Traefik ingress -> Service/ytdl:80 -> app pod:3000`

### Queue and worker topology

- `k8s/redis.yml` defines Redis as an in-cluster dependency:
  - `Deployment/redis`, 1 replica
  - `Service/redis` on `6379`
- `k8s/app.yml` injects `REDIS_HOST=redis` and `REDIS_PORT=6379`.
- `src/lib/queue.ts` confirms the app enqueues jobs into BullMQ on Redis.
- `k8s/worker.yml` defines a separate `Deployment/ytdl-worker`, 1 replica.
- `src/worker/worker.ts` confirms the worker pulls jobs from the `ytdl` queue and runs `yt-dlp`.

Operational flow:

`browser -> app -> Redis queue -> worker -> filesystem`

### Storage topology

- `k8s/pvc.yml` defines:
  - `PVC/ytdlq`, `100Gi`, `ReadWriteMany`, storage class `nfs-storage`
  - `PVC/redis`, `1Gi`, `ReadWriteOnce`, storage class `nfs-storage`
- `k8s/worker.yml` mounts `ytdlq` at `/app/data`.
- `src/worker/worker.ts` writes downloads to `data/videos/...`.
- Because the container `WORKDIR` is `/app` in `Dockerfile`, that path resolves to `/app/data/videos/...`, i.e. onto the `ytdlq` PVC.
- `k8s/redis.yml` mounts the Redis PVC at `/data/redis`.

### TLS and DNS assumptions

- The public name for the app is hard-coded as `ytdl.mink.lan` in `k8s/app.yml`.
- TLS is terminated at Traefik using secret `ytdl-tls`.
- `scripts/create-ytdl-tls-secret.sh` generates a self-signed cert with OpenSSL and installs it as a Kubernetes TLS secret.
- That implies this is intended as a private/internal deployment, not a public CA-backed internet site.
- Your NetBird custom zone for `mink.lan` fits that model: peers resolve `ytdl.mink.lan` to a private overlay IP and then hit Traefik over the NetBird tunnel.

### Important manifest gap

- The app code has `listVideos` in `src/trpc/routers/_app.ts`, which reads from local `data/`.
- But `k8s/app.yml` does **not** mount the `ytdlq` PVC into the app pod.
- So in Kubernetes, the worker can write downloaded files, but the app pod cannot currently read the same `data/` tree unless some out-of-repo mount exists on the live cluster.
- This does not directly affect ingress/networking, but it is a likely functional mismatch worth checking on the Pi.

## Likely current live networking model

Based on your note, the live Raspberry Pi setup is probably **not** using only the repo manifests anymore:

- K3s Traefik was originally running with its normal packaged setup.
- Traffic arriving on the Pi's NetBird interface `wt0` was not being served correctly on the NetBird IP.
- You then applied a custom Traefik manifest/config.
- You removed `svclb` involvement for Traefik.
- Traefik now binds host `80` and `443` directly.

That workaround makes sense because it bypasses some combination of:

- K3s ServiceLB (`svclb-traefik-*`) host-port plumbing
- kube-proxy/nodeport forwarding behavior
- host firewall/NAT behavior for traffic arriving specifically on `wt0`

I cannot prove the exact failing component from this repo alone, because the repo does not include:

- the current Traefik override you applied on the Pi
- the current K3s packaged Traefik service definition
- the Pi's actual `iptables`/`nftables` state
- the Pi's `wt0` address/routing/firewall state

## How NetBird likely fits

The intended external path for peers is probably:

`NetBird peer -> NetBird DNS custom zone (mink.lan) -> ytdl.mink.lan resolves to Pi wt0 IP -> Pi accepts 80/443 on wt0 -> Traefik -> Ingress/ytdl -> Service/ytdl -> app pod`

That means three separate systems must all line up:

1. NetBird DNS must return the Pi's reachable NetBird IP for `ytdl.mink.lan`.
2. The Pi must accept TCP `80/443` arriving on `wt0`.
3. K3s/Traefik must route that traffic to the `Ingress/ytdl` object and then to `Service/ytdl`.

## Alternative approach: redirect only `wt0` traffic, avoid privileged low-port bind

### The core idea

Instead of making Traefik itself bind host `80/443`, keep Traefik on normal Kubernetes service plumbing and do this on the Pi:

- if traffic arrives on interface `wt0` with destination port `80`, redirect it to Traefik's HTTP NodePort
- if traffic arrives on interface `wt0` with destination port `443`, redirect it to Traefik's HTTPS NodePort

Then the path becomes:

`peer -> wt0:80/443 -> host nftables/iptables REDIRECT -> localhost/high-nodeport -> kube-proxy NodePort -> Traefik Service -> Traefik pod -> Ingress/ytdl -> app Service -> app pod`

### Why this removes the privileged-port issue

- Traefik no longer needs to bind low ports directly on the host.
- The host kernel rewrites incoming `80/443` traffic to high ports before local delivery.
- High NodePorts do not need `CAP_NET_BIND_SERVICE` and do not need `net.ipv4.ip_unprivileged_port_start=0`.

### The important nuance: not literally "default defaults"

If you restore **fully default** K3s Traefik behavior, K3s usually creates a `LoadBalancer` service for Traefik and `svclb-traefik-*` pods reclaim host `80/443`.

That conflicts with the redirect-only design, because:

- `svclb` would already occupy `80/443`
- you would not need the redirect anymore
- or you would have overlapping/unclear ownership of those ports

So the redirect design is best described as:

- keep Traefik close to packaged defaults
- but expose Traefik as `NodePort` rather than `LoadBalancer`
- do **not** have `svclb-traefik-*` claim host `80/443`

In practice this is still much simpler than a custom host-bound Traefik setup.

### Recommended target design

Recommended architecture:

1. Traefik service type = `NodePort`
2. Fixed NodePorts, for example:
   - HTTP `30080`
   - HTTPS `30443`
3. Traefik pod/container uses normal chart defaults
4. Host firewall rules redirect only `wt0` traffic:
   - `wt0 tcp/80 -> 30080`
   - `wt0 tcp/443 -> 30443`
5. NetBird custom zone keeps resolving `ytdl.mink.lan` to the Pi's `wt0` IP

This preserves the peer-only access model cleanly.

### Example redirect rules

#### nftables flavor

These are example commands only. Do not apply them until we confirm your current ruleset and NodePorts.

```bash
sudo nft add table inet netbird_redirect
sudo nft 'add chain inet netbird_redirect prerouting { type nat hook prerouting priority dstnat; policy accept; }'
sudo nft add rule inet netbird_redirect prerouting iifname "wt0" tcp dport 80 redirect to :30080
sudo nft add rule inet netbird_redirect prerouting iifname "wt0" tcp dport 443 redirect to :30443
```

#### iptables-nft flavor

```bash
sudo iptables -t nat -A PREROUTING -i wt0 -p tcp --dport 80 -j REDIRECT --to-ports 30080
sudo iptables -t nat -A PREROUTING -i wt0 -p tcp --dport 443 -j REDIRECT --to-ports 30443
```

Notes:

- These only affect traffic entering on `wt0`.
- LAN traffic on `eth0`/`wlan0` is untouched.
- If you want to restrict more tightly, you can additionally match the NetBird CGNAT range for your account.
- For traffic coming from a *different* NetBird peer, `PREROUTING` is the right hook.
- For traffic generated locally on the Pi to its own `wt0` IP, an `OUTPUT` redirect may also be needed for self-tests, but not for real peer traffic.

### Example Traefik shape for the redirect design

Exact chart keys may vary by K3s version, so verify against the live chart first.

Conceptually, the Traefik HelmChartConfig should look like:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      type: NodePort
    ports:
      web:
        nodePort: 30080
      websecure:
        nodePort: 30443
```

The point is:

- no hostNetwork bind on 80/443
- no custom privileged low-port Traefik process binding
- a stable pair of NodePorts for the host redirect rules to target

## What I need from the Pi to confirm the real situation

I need both Kubernetes state and host networking state. Please run the commands below on the Raspberry Pi and paste the output into this file under each command block.

If a command is noisy, paste the full output anyway unless it contains secrets.

## Pi data collection

### 1) K3s / Traefik / ingress state

Command:

```bash
sudo kubectl get nodes -o wide
sudo kubectl get pods -A -o wide
sudo kubectl get svc -A -o wide
sudo kubectl get ingress -A -o wide
```

Paste output here:

```text
den@pi:~$ kubectl get nodes -o wide
NAME   STATUS   ROLES                  AGE    VERSION        INTERNAL-IP     EXTERNAL-IP   OS-IMAGE             KERNEL-VERSION     CONTAINER-RUNTIME
pi     Ready    control-plane,master   488d   v1.30.6+k3s1   192.168.1.105   <none>        Ubuntu 24.04.1 LTS   6.8.0-1047-raspi   containerd://1.7.22-k3s1

den@pi:~$ kubectl get pods -A -o wide
NAMESPACE     NAME                                      READY   STATUS      RESTARTS       AGE    IP              NODE   NOMINATED NODE   READINESS GATES
default       redis-84f85f9cdc-nfbl2                    1/1     Running     3 (24d ago)    131d   10.42.0.11      pi     <none>           <none>
default       registry-7cb844c9cd-ztqk4                 1/1     Running     2 (24d ago)    83d    10.42.0.10      pi     <none>           <none>
default       sumnivore-6ffd56fdd-wbgkf                 1/1     Running     0              18d    10.42.0.32      pi     <none>           <none>
default       sumnivore-bun-7798d4b669-x6rhh            2/2     Running     0              19d    10.42.0.29      pi     <none>           <none>
default       sumnivore-worker-7884fdf647-jlrmg         1/1     Running     0              19d    10.42.0.31      pi     <none>           <none>
default       tuby-7d547457b-kgqk8                      1/1     Running     2 (24d ago)    75d    192.168.1.105   pi     <none>           <none>
default       ytdl-576d886644-qwg9l                     1/1     Running     0              8h     10.42.0.51      pi     <none>           <none>
default       ytdl-worker-5dc998fb9d-hfgmb              1/1     Running     0              8h     10.42.0.52      pi     <none>           <none>
kube-system   coredns-7b98449c4-ghtp8                   1/1     Running     9 (24d ago)    488d   10.42.0.7       pi     <none>           <none>
kube-system   helm-install-traefik-crd-dj98x            0/1     Completed   0              488d   <none>          pi     <none>           <none>
kube-system   helm-install-traefik-ptr7c                0/1     Completed   0              9h     10.42.0.50      pi     <none>           <none>
kube-system   local-path-provisioner-595dcfc56f-fdrtk   1/1     Running     8 (24d ago)    488d   10.42.0.6       pi     <none>           <none>
kube-system   metrics-server-cdcc87586-phckc            1/1     Running     9 (24d ago)    488d   10.42.0.5       pi     <none>           <none>
kube-system   nfs-provisioner-59b885585d-2klbz          1/1     Running     333 (9h ago)   488d   10.42.0.9       pi     <none>           <none>
kube-system   traefik-78b594d68b-6j5nd                  1/1     Running     0              9h     192.168.1.105   pi     <none>           <none>

den@pi:~$ kubectl get svc -A -o wide
NAMESPACE     NAME             TYPE        CLUSTER-IP      EXTERNAL-IP      PORT(S)                  AGE    SELECTOR
default       kubernetes       ClusterIP   10.43.0.1       <none>           443/TCP                  488d   <none>
default       redis            ClusterIP   10.43.111.105   <none>           6379/TCP                 131d   app=redis
default       registry         NodePort    10.43.188.231   <none>           5000:30500/TCP           83d    app=registry
default       sumnivore        ClusterIP   10.43.11.157    <none>           80/TCP                   487d   app=sumnivore
default       sumnivore-bun    ClusterIP   10.43.112.136   <none>           80/TCP                   19d    app=sumnivore-bun
default       tuby             NodePort    10.43.158.42    <none>           80:30080/TCP             75d    app=tuby
default       tuby-dlna        NodePort    10.43.181.51    <none>           1900:32197/UDP           75d    app=tuby
default       ytdl             ClusterIP   10.43.63.99     <none>           80/TCP                   75d    app=ytdl,component=app
kube-system   kube-dns         ClusterIP   10.43.0.10      <none>           53/UDP,53/TCP,9153/TCP   488d   k8s-app=kube-dns
kube-system   metrics-server   ClusterIP   10.43.151.224   <none>           443/TCP                  488d   k8s-app=metrics-server
kube-system   traefik          ClusterIP   10.43.85.149    100.90.167.160   80/TCP,443/TCP           488d   app.kubernetes.io/instance=traefik-kube-system,app.kubernetes.io/name=traefik

den@pi:~$ kubectl get ingress -A -o wide
NAMESPACE   NAME            CLASS     HOSTS                          ADDRESS         PORTS     AGE
default     registry        traefik   pi.home                        192.168.1.105   80        83d
default     sumnivore       traefik   pi.home,pi.mink.danielgal.eu   192.168.1.105   80        487d
default     sumnivore-bun   traefik   pi.home                        192.168.1.105   80        19d
default     ytdl            traefik   ytdl.mink.lan                  192.168.1.105   80, 443   75d
```

### 2) Traefik service details

Command:

```bash
sudo kubectl -n kube-system get svc traefik -o yaml
```

Paste output here:

```yaml
den@pi:~$ kubectl -n kube-system get svc traefik -o yaml
apiVersion: v1
kind: Service
metadata:
  annotations:
    meta.helm.sh/release-name: traefik
    meta.helm.sh/release-namespace: kube-system
  creationTimestamp: "2024-11-03T13:06:30Z"
  labels:
    app.kubernetes.io/instance: traefik-kube-system
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/name: traefik
    helm.sh/chart: traefik-27.0.201_up27.0.2
  name: traefik
  namespace: kube-system
  resourceVersion: "33718135"
  uid: 293c7e84-e5ec-49b3-ae90-bc8f8d7476b6
spec:
  clusterIP: 10.43.85.149
  clusterIPs:
  - 10.43.85.149
  externalIPs:
  - 100.90.167.160
  externalTrafficPolicy: Cluster
  internalTrafficPolicy: Cluster
  ipFamilies:
  - IPv4
  ipFamilyPolicy: PreferDualStack
  ports:
  - name: web
    port: 80
    protocol: TCP
    targetPort: web
  - name: websecure
    port: 443
    protocol: TCP
    targetPort: websecure
  selector:
    app.kubernetes.io/instance: traefik-kube-system
    app.kubernetes.io/name: traefik
  sessionAffinity: None
  type: ClusterIP
status:
  loadBalancer: {}
```

### 3) Traefik workload details

Command:

```bash
sudo kubectl -n kube-system get deploy,ds,pods -l app.kubernetes.io/name=traefik -o wide
sudo kubectl -n kube-system describe svc traefik
sudo kubectl -n kube-system logs deploy/traefik --tail=200
```

Paste output here:

```text
den@pi:~$ kubectl -n kube-system get deploy,ds,pods -l app.kubernetes.io/name=traefik -o wide
NAME                      READY   UP-TO-DATE   AVAILABLE   AGE    CONTAINERS   IMAGES                                     SELECTOR
deployment.apps/traefik   1/1     1            1           488d   traefik      rancher/mirrored-library-traefik:2.11.10   app.kubernetes.io/instance=traefik-kube-system,app.kubernetes.io/name=traefik

NAME                           READY   STATUS    RESTARTS   AGE   IP              NODE   NOMINATED NODE   READINESS GATES
pod/traefik-78b594d68b-6j5nd   1/1     Running   0          9h    192.168.1.105   pi     <none>           <none>

den@pi:~$ kubectl -n kube-system describe svc traefik
Name:                     traefik
Namespace:                kube-system
Labels:                   app.kubernetes.io/instance=traefik-kube-system
                          app.kubernetes.io/managed-by=Helm
                          app.kubernetes.io/name=traefik
                          helm.sh/chart=traefik-27.0.201_up27.0.2
Annotations:              meta.helm.sh/release-name: traefik
                          meta.helm.sh/release-namespace: kube-system
Selector:                 app.kubernetes.io/instance=traefik-kube-system,app.kubernetes.io/name=traefik
Type:                     ClusterIP
IP Family Policy:         PreferDualStack
IP Families:              IPv4
IP:                       10.43.85.149
IPs:                      10.43.85.149
External IPs:             100.90.167.160
Port:                     web  80/TCP
TargetPort:               web/TCP
Endpoints:                192.168.1.105:80
Port:                     websecure  443/TCP
TargetPort:               websecure/TCP
Endpoints:                192.168.1.105:443
Session Affinity:         None
External Traffic Policy:  Cluster
Internal Traffic Policy:  Cluster
Events:                   <none>

den@pi:~$ kubectl -n kube-system logs deploy/traefik --tail=200
time="2026-03-06T23:08:32Z" level=info msg="Configuration loaded from flags."
```

### 4) Packaged manifests and overrides on disk

Command:

```bash
sudo ls -la /var/lib/rancher/k3s/server/manifests
sudo sed -n '1,240p' /var/lib/rancher/k3s/server/manifests/traefik.yaml
sudo sed -n '1,240p' /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
sudo sed -n '1,240p' /var/lib/rancher/k3s/server/manifests/*traefik*
```

Paste output here:

```text
den@pi:~$ sudo ls -la /var/lib/rancher/k3s/server/manifests
total 44
drwx------ 3 root root 4096 Mar  7 00:07 .
drwx------ 8 root root 4096 Feb 10 21:48 ..
-rw------- 1 root root 1914 Feb 10 21:48 ccm.yaml
-rw------- 1 root root 4969 Feb 10 21:48 coredns.yaml
-rw------- 1 root root 3298 Feb 10 21:48 local-storage.yaml
drwx------ 2 root root 4096 Nov  3  2024 metrics-server
-rw------- 1 root root 1545 Feb 10 21:48 rolebindings.yaml
-rw------- 1 root root  927 Feb 10 21:48 runtimes.yaml
-rw-r--r-- 1 root root  775 Mar  7 00:07 traefik-config.yaml
-rw------- 1 root root 1106 Feb 10 21:48 traefik.yaml

den@pi:~$ sudo sed -n '1,240p' /var/lib/rancher/k3s/server/manifests/traefik.yaml
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: traefik-crd
  namespace: kube-system
spec:
  chart: https://%{KUBERNETES_API}%/static/charts/traefik-crd-27.0.201+up27.0.2.tgz
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: traefik
  namespace: kube-system
spec:
  chart: https://%{KUBERNETES_API}%/static/charts/traefik-27.0.201+up27.0.2.tgz
  set:
    global.systemDefaultRegistry: ""
  valuesContent: |-
    deployment:
      podAnnotations:
        prometheus.io/port: "8082"
        prometheus.io/scrape: "true"
    providers:
      kubernetesIngress:
        publishedService:
          enabled: true
    priorityClassName: "system-cluster-critical"
    image:
      repository: "rancher/mirrored-library-traefik"
      tag: "2.11.10"
    tolerations:
    - key: "CriticalAddonsOnly"
      operator: "Exists"
    - key: "node-role.kubernetes.io/control-plane"
      operator: "Exists"
      effect: "NoSchedule"
    - key: "node-role.kubernetes.io/master"
      operator: "Exists"
      effect: "NoSchedule"
    service:
      ipFamilyPolicy: "PreferDualStack"
      
den@pi:~$ sudo sed -n '1,240p' /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    hostNetwork: true
    dnsPolicy: ClusterFirstWithHostNet
    deployment:
      replicas: 1
      strategy:
        type: Recreate
    service:
      type: ClusterIP
    ports:
      web:
        port: 80
        exposedPort: 80
      websecure:
        port: 443
        exposedPort: 443
    podSecurityContext:
      runAsNonRoot: true
      runAsUser: 65532
      runAsGroup: 65532
      fsGroup: 65532
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
          - ALL
        add:
          - NET_BIND_SERVICE
      seccompProfile:
        type: RuntimeDefault
        
den@pi:~$ sudo sed -n '1,240p' /var/lib/rancher/k3s/server/manifests/*traefik*
sed: can't read /var/lib/rancher/k3s/server/manifests/*traefik*: No such file or directory        
```

If one of those files does not exist, paste the error too.

### 5) ytdl app objects

Command:

```bash
sudo kubectl get deploy,svc,ingress,pvc,secrets
sudo kubectl describe ingress ytdl
sudo kubectl get endpoints,endpointslices ytdl redis -o yaml
```

Paste output here:

```text
den@pi:~$ kubectl get deploy,svc,ingress,pvc,secrets
NAME                               READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/redis              1/1     1            1           131d
deployment.apps/registry           1/1     1            1           83d
deployment.apps/sumnivore          1/1     1            1           57d
deployment.apps/sumnivore-bun      1/1     1            1           19d
deployment.apps/sumnivore-worker   1/1     1            1           57d
deployment.apps/tuby               1/1     1            1           75d
deployment.apps/ytdl               1/1     1            1           75d
deployment.apps/ytdl-worker        1/1     1            1           131d

NAME                    TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)          AGE
service/kubernetes      ClusterIP   10.43.0.1       <none>        443/TCP          488d
service/redis           ClusterIP   10.43.111.105   <none>        6379/TCP         131d
service/registry        NodePort    10.43.188.231   <none>        5000:30500/TCP   83d
service/sumnivore       ClusterIP   10.43.11.157    <none>        80/TCP           487d
service/sumnivore-bun   ClusterIP   10.43.112.136   <none>        80/TCP           19d
service/tuby            NodePort    10.43.158.42    <none>        80:30080/TCP     75d
service/tuby-dlna       NodePort    10.43.181.51    <none>        1900:32197/UDP   75d
service/ytdl            ClusterIP   10.43.63.99     <none>        80/TCP           75d

NAME                                      CLASS     HOSTS                          ADDRESS         PORTS     AGE
ingress.networking.k8s.io/registry        traefik   pi.home                        192.168.1.105   80        83d
ingress.networking.k8s.io/sumnivore       traefik   pi.home,pi.mink.danielgal.eu   192.168.1.105   80        487d
ingress.networking.k8s.io/sumnivore-bun   traefik   pi.home                        192.168.1.105   80        19d
ingress.networking.k8s.io/ytdl            traefik   ytdl.mink.lan                  192.168.1.105   80, 443   75d

NAME                                     STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
persistentvolumeclaim/redis              Bound    pvc-5eb1d93f-e577-4ea9-92c4-9d87526382b3   1Gi        RWO            nfs-storage    <unset>                 131d
persistentvolumeclaim/registry-storage   Bound    pvc-e3f34b12-bf51-47b9-a933-e70cf86458db   20Gi       RWO            nfs-storage    <unset>                 83d
persistentvolumeclaim/sumnivore          Bound    pvc-c30f84b6-b758-4e6d-bfce-c67269a47ce7   10Mi       RWO            nfs-storage    <unset>                 487d
persistentvolumeclaim/ytdl-config        Bound    pvc-3c242497-7e1f-4bf9-81cf-ab192711f35d   100Mi      RWX            nfs-storage    <unset>                 27d
persistentvolumeclaim/ytdlq              Bound    pvc-dfc6ba6e-c7d6-4d1c-bed5-294f81c408d1   100Gi      RWX            nfs-storage    <unset>                 131d

NAME                  TYPE                DATA   AGE
secret/sumnivore      Opaque              6      487d
secret/ytdl-cookies   Opaque              1      27d
secret/ytdl-tls       kubernetes.io/tls   2      10h

den@pi:~$ kubectl describe ingress ytdl
Name:             ytdl
Labels:           <none>
Namespace:        default
Address:          192.168.1.105
Ingress Class:    traefik
Default backend:  <default>
TLS:
  ytdl-tls terminates ytdl.mink.lan
Rules:
  Host           Path  Backends
  ----           ----  --------
  ytdl.mink.lan
                 /   ytdl:80 (10.42.0.51:3000)
Annotations:     <none>
Events:          <none>

den@pi:~$ kubectl get endpoints,endpointslices ytdl redis -o yaml
apiVersion: v1
items:
- apiVersion: v1
  kind: Endpoints
  metadata:
    creationTimestamp: "2025-12-21T19:36:16Z"
    name: ytdl
    namespace: default
    resourceVersion: "33720577"
    uid: a4bffa33-0a1d-45f0-8760-d89f3964a1d4
  subsets:
  - addresses:
    - ip: 10.42.0.51
      nodeName: pi
      targetRef:
        kind: Pod
        name: ytdl-576d886644-qwg9l
        namespace: default
        uid: e9f40b18-19fb-4c01-9022-4f15f222cc16
    ports:
    - port: 3000
      protocol: TCP
- apiVersion: v1
  kind: Endpoints
  metadata:
    annotations:
      endpoints.kubernetes.io/last-change-trigger-time: "2026-02-10T20:55:10Z"
    creationTimestamp: "2025-10-26T11:02:04Z"
    name: redis
    namespace: default
    resourceVersion: "32057290"
    uid: 26b577ab-7297-4ee0-b785-45d5d3dc6be4
  subsets:
  - addresses:
    - ip: 10.42.0.11
      nodeName: pi
      targetRef:
        kind: Pod
        name: redis-84f85f9cdc-nfbl2
        namespace: default
        uid: 63b18702-9950-403a-84e2-0ea23a1fe3f0
    ports:
    - port: 6379
      protocol: TCP
kind: List
metadata:
  resourceVersion: ""
Error from server (NotFound): endpointslices.discovery.k8s.io "ytdl" not found
Error from server (NotFound): endpointslices.discovery.k8s.io "redis" not found
```

### 6) Host listeners on 80/443 and NodePorts

Command:

```bash
sudo ss -ltnp
sudo ss -lunp
```

Paste output here:

```text
den@pi:~$ sudo ss -ltnp
State        Recv-Q       Send-Q               Local Address:Port                Peer Address:Port       Process
LISTEN       0            64                         0.0.0.0:2049                     0.0.0.0:*          
LISTEN       0            4096                    127.0.0.54:53                       0.0.0.0:*           users:(("systemd-resolve",pid=653,fd=17))
LISTEN       0            128                        0.0.0.0:44322                    0.0.0.0:*           users:(("pmproxy",pid=1091,fd=13))
LISTEN       0            128                        0.0.0.0:44323                    0.0.0.0:*           users:(("pmproxy",pid=1091,fd=15))
LISTEN       0            5                          0.0.0.0:44321                    0.0.0.0:*           users:(("pmcd",pid=1053,fd=0))
LISTEN       0            4096                     127.0.0.1:10257                    0.0.0.0:*           users:(("k3s-server",pid=2860,fd=164))
LISTEN       0            4096                     127.0.0.1:10256                    0.0.0.0:*           users:(("k3s-server",pid=2860,fd=181))
LISTEN       0            4096                     127.0.0.1:10259                    0.0.0.0:*           users:(("k3s-server",pid=2860,fd=182))
LISTEN       0            4096                     127.0.0.1:10258                    0.0.0.0:*           users:(("k3s-server",pid=2860,fd=157))
LISTEN       0            4096                     127.0.0.1:10249                    0.0.0.0:*           users:(("k3s-server",pid=2860,fd=187))
LISTEN       0            4096                     127.0.0.1:10248                    0.0.0.0:*           users:(("k3s-server",pid=2860,fd=215))
LISTEN       0            4096                       0.0.0.0:36369                    0.0.0.0:*           users:(("rpc.statd",pid=1008,fd=9))
LISTEN       0            4096                 127.0.0.53%lo:53                       0.0.0.0:*           users:(("systemd-resolve",pid=653,fd=15))
LISTEN       0            4096                     127.0.0.1:6444                     0.0.0.0:*           users:(("k3s-server",pid=2860,fd=18))
LISTEN       0            512                        0.0.0.0:8096                     0.0.0.0:*           users:(("jellyfin",pid=7827,fd=498))
LISTEN       0            4096                       0.0.0.0:111                      0.0.0.0:*           users:(("rpcbind",pid=646,fd=4),("systemd",pid=1,fd=126))
LISTEN       0            5                          0.0.0.0:4330                     0.0.0.0:*           users:(("pmlogger",pid=1966,fd=7))
LISTEN       0            4096                     127.0.0.1:10010                    0.0.0.0:*           users:(("containerd",pid=3681,fd=12))
LISTEN       0            4096                       0.0.0.0:33377                    0.0.0.0:*           users:(("rpc.mountd",pid=1796634,fd=5))
LISTEN       0            4096                       0.0.0.0:33729                    0.0.0.0:*           users:(("rpc.mountd",pid=1796634,fd=9))
LISTEN       0            4096                       0.0.0.0:41877                    0.0.0.0:*           users:(("rpc.mountd",pid=1796634,fd=13))
LISTEN       0            64                         0.0.0.0:38835                    0.0.0.0:*          
LISTEN       0            4096                             *:10250                          *:*           users:(("k3s-server",pid=2860,fd=213))
LISTEN       0            64                            [::]:2049                        [::]:*          
LISTEN       0            4096                             *:6443                           *:*           users:(("k3s-server",pid=2860,fd=14))
LISTEN       0            4096                          [::]:39491                       [::]:*           users:(("rpc.mountd",pid=1796634,fd=11))
LISTEN       0            4096                          [::]:47895                       [::]:*           users:(("rpc.mountd",pid=1796634,fd=15))
LISTEN       0            4096                          [::]:60629                       [::]:*           users:(("rpc.mountd",pid=1796634,fd=7))
LISTEN       0            4096                          [::]:44369                       [::]:*           users:(("rpc.statd",pid=1008,fd=11))
LISTEN       0            128                           [::]:44322                       [::]:*           users:(("pmproxy",pid=1091,fd=14))
LISTEN       0            128                           [::]:44323                       [::]:*           users:(("pmproxy",pid=1091,fd=16))
LISTEN       0            5                             [::]:44321                       [::]:*           users:(("pmcd",pid=1053,fd=3))
LISTEN       0            4096                             *:80                             *:*           users:(("traefik",pid=2726568,fd=7))
LISTEN       0            4096                          [::]:111                         [::]:*           users:(("rpcbind",pid=646,fd=6),("systemd",pid=1,fd=128))
LISTEN       0            4096                             *:22                             *:*           users:(("sshd",pid=201266,fd=3),("systemd",pid=1,fd=188))
LISTEN       0            32                               *:21                             *:*           users:(("vsftpd",pid=920,fd=3))
LISTEN       0            5                             [::]:4330                        [::]:*           users:(("pmlogger",pid=1966,fd=8))
LISTEN       0            4096                             *:443                            *:*           users:(("traefik",pid=2726568,fd=8))
LISTEN       0            4096                             *:9000                           *:*           users:(("traefik",pid=2726568,fd=6))
LISTEN       0            4096                             *:9100                           *:*           users:(("traefik",pid=2726568,fd=3))
LISTEN       0            64                            [::]:33819                       [::]:*          

den@pi:~$ sudo ss -lunp
State      Recv-Q     Send-Q                            Local Address:Port          Peer Address:Port    Process
UNCONN     0          0                                     127.0.0.1:3128               0.0.0.0:*        users:(("netbird",pid=628939,fd=19))
UNCONN     0          0                                       0.0.0.0:7359               0.0.0.0:*        users:(("jellyfin",pid=7827,fd=473))
UNCONN     0          0                                       0.0.0.0:49086              0.0.0.0:*        users:(("rpc.mountd",pid=1796634,fd=12))
UNCONN     0          0                                100.90.167.160:53                 0.0.0.0:*        users:(("netbird",pid=628939,fd=8))
UNCONN     0          0                                    127.0.0.54:53                 0.0.0.0:*        users:(("systemd-resolve",pid=653,fd=16))
UNCONN     0          0                                 127.0.0.53%lo:53                 0.0.0.0:*        users:(("systemd-resolve",pid=653,fd=14))
UNCONN     0          0                            192.168.1.105%eth0:68                 0.0.0.0:*        users:(("systemd-network",pid=771,fd=24))
UNCONN     0          0                                       0.0.0.0:111                0.0.0.0:*        users:(("rpcbind",pid=646,fd=5),("systemd",pid=1,fd=127))
UNCONN     0          0                                     10.42.0.1:45258              0.0.0.0:*        users:(("jellyfin",pid=7827,fd=470))
UNCONN     0          0                                       0.0.0.0:37139              0.0.0.0:*        users:(("rpc.mountd",pid=1796634,fd=8))
UNCONN     0          0                                       0.0.0.0:8472               0.0.0.0:*       
UNCONN     0          0                                       0.0.0.0:53884              0.0.0.0:*        users:(("avahi-daemon",pid=674068,fd=14))
UNCONN     0          0                                 192.168.1.105:49846              0.0.0.0:*        users:(("jellyfin",pid=7827,fd=468))
UNCONN     0          0                                     127.0.0.1:760                0.0.0.0:*        users:(("rpc.statd",pid=1008,fd=5))
UNCONN     0          0                                       0.0.0.0:33904              0.0.0.0:*       
UNCONN     0          0                                       0.0.0.0:5353               0.0.0.0:*        users:(("avahi-daemon",pid=674068,fd=12))
UNCONN     0          0                               239.255.255.250:1900               0.0.0.0:*        users:(("jellyfin",pid=7827,fd=467))
UNCONN     0          0                               239.255.255.250:1900               0.0.0.0:*        users:(("jellyfin",pid=7827,fd=466))
UNCONN     0          0                               239.255.255.250:1900               0.0.0.0:*        users:(("jellyfin",pid=7827,fd=267))
UNCONN     0          0                                       0.0.0.0:47130              0.0.0.0:*        users:(("rpc.statd",pid=1008,fd=8))
UNCONN     0          0                                       0.0.0.0:39486              0.0.0.0:*        users:(("rpc.mountd",pid=1796634,fd=4))
UNCONN     0          0                                       0.0.0.0:51820              0.0.0.0:*       
UNCONN     0          0                                     10.42.0.0:39699              0.0.0.0:*        users:(("jellyfin",pid=7827,fd=469))
UNCONN     0          0                                          [::]:60271                 [::]:*       
UNCONN     0          0                                          [::]:56758                 [::]:*        users:(("rpc.mountd",pid=1796634,fd=14))
UNCONN     0          0                                          [::]:111                   [::]:*        users:(("rpcbind",pid=646,fd=7),("systemd",pid=1,fd=129))
UNCONN     0          0                                          [::]:33182                 [::]:*        users:(("rpc.mountd",pid=1796634,fd=10))
UNCONN     0          0              [fe80::da3a:ddff:fe34:59fc]%eth0:546                   [::]:*        users:(("systemd-network",pid=771,fd=22))
UNCONN     0          0                                          [::]:57996                 [::]:*        users:(("rpc.statd",pid=1008,fd=10))
UNCONN     0          0                                          [::]:5353                  [::]:*        users:(("avahi-daemon",pid=674068,fd=13))
UNCONN     0          0                                          [::]:51277                 [::]:*        users:(("avahi-daemon",pid=674068,fd=15))
UNCONN     0          0                                          [::]:55825                 [::]:*        users:(("rpc.mountd",pid=1796634,fd=6))
UNCONN     0          0                                          [::]:51820                 [::]:*       
```

I am specifically looking for listeners or sockets involving:

- `:80`
- `:443`
- the Traefik NodePorts, if present
- `svclb-traefik`

### 7) Network interfaces and routes

Command:

```bash
ip -br addr
ip route show table main
ip rule show
```

Paste output here:

```text
den@pi:~$ ip -br addr
lo               UNKNOWN        127.0.0.1/8 ::1/128
eth0             UP             192.168.1.105/24 metric 100 2001:4c4e:24ea:ab00:da3a:ddff:fe34:59fc/64 fe80::da3a:ddff:fe34:59fc/64
wlan0            DOWN
flannel.1        UNKNOWN        10.42.0.0/32 fe80::24ae:e0ff:fe38:2f73/64
cni0             UP             10.42.0.1/24 fe80::8409:2bff:feb2:3b3e/64
veth3ca3de11@if2 UP             fe80::4825:73ff:fe47:3c85/64
veth33dca2b4@if2 UP             fe80::ac06:70ff:fe44:4a71/64
veth08bf8967@if2 UP             fe80::e069:e8ff:fea1:9407/64
vethb000ffa4@if2 UP             fe80::4068:d3ff:fe26:7dfb/64
veth55b6ef36@if2 UP             fe80::5025:edff:fe3f:3e53/64
veth42f75a20@if2 UP             fe80::8c23:5dff:fee6:ebdd/64
vetha69ed4fa@if2 UP             fe80::840f:67ff:fe41:64e6/64
vethd7fd638a@if2 UP             fe80::b81b:fff:fe45:b0e8/64
vethbe61d010@if2 UP             fe80::9805:aeff:fe1e:f418/64
wt0              UNKNOWN        100.90.167.160/16
veth29292112@if2 UP             fe80::406e:88ff:fe08:fdfa/64
veth3978f5fa@if2 UP             fe80::e4af:9aff:fe1c:6610/64

den@pi:~$ ip route show table main
default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.105 metric 100
10.42.0.0/24 dev cni0 proto kernel scope link src 10.42.0.1
100.90.0.0/16 dev wt0 proto kernel scope link src 100.90.167.160
192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.105 metric 100
192.168.1.1 dev eth0 proto dhcp scope link src 192.168.1.105 metric 100

den@pi:~$ ip rule show
0:      from all lookup local
105:    from all lookup main suppress_prefixlength 0
110:    not from all fwmark 0x1bd00 lookup netbird
32766:  from all lookup main
32767:  from all lookup default
```

### 8) NetBird state

Command:

```bash
sudo netbird status
sudo netbird status --detail
```

Paste output here:

```text
den@pi:~$ sudo netbird status --detail
Peers detail:
 battlestation.mink.danielgal.eu:
  NetBird IP: 100.90.149.44
  Public key: gYiITODIVYl/0mnGCObk64cTLhUQ8JwF+lnUEQK0cWk=
  Status: Connected
  -- detail --
  Connection type: P2P
  ICE candidate (Local/Remote): host/prflx
  ICE candidate endpoints (Local/Remote): 10.42.0.1:51820/192.168.1.159:51820
  Relay server address: rels://mink.danielgal.eu:443
  Last connection update: 48 minutes, 35 seconds ago
  Last WireGuard handshake: 18 seconds ago
  Transfer status (received/sent) 98.0 KiB/183.1 KiB
  Quantum resistance: false
  Networks: -
  Latency: 1.667528ms

 cph2493eea.mink.danielgal.eu:
  NetBird IP: 100.90.226.194
  Public key: X9XaObDTsnHJwDtd49z2+Gyr9VOgROfBB4ztM+I69m4=
  Status: Connected
  -- detail --
  Connection type: Relayed
  ICE candidate (Local/Remote): -/-
  ICE candidate endpoints (Local/Remote): -/-
  Relay server address: rels://mink.danielgal.eu:443
  Last connection update: 39 minutes, 49 seconds ago
  Last WireGuard handshake: 42 seconds ago
  Transfer status (received/sent) 45.2 KiB/49.7 KiB
  Quantum resistance: false
  Networks: -
  Latency: 0s

Events:
  [INFO] SYSTEM (1ea5d8e0-9a59-4bff-8f44-db2c54994a23)
    Message: Network map updated
    Time: 18 days, 10 hours ago
  [INFO] SYSTEM (940843ca-078d-4a92-8d02-d6532355fc4b)
    Message: Network map updated
    Time: 18 days, 10 hours ago
  [INFO] SYSTEM (87b3fdfe-f3e7-49ff-aef2-ca1bb1945581)
    Message: Network map updated
    Time: 12 hours, 22 minutes ago
  [INFO] SYSTEM (f9024cbd-c6cd-400a-b851-9c1cc0652b17)
    Message: Network map updated
    Time: 11 hours, 4 minutes ago
  [INFO] SYSTEM (2f9f9240-f7af-4369-b0e3-589b4c48bb45)
    Message: Network map updated
    Time: 10 hours, 53 minutes ago
  [INFO] SYSTEM (4e7e3189-3703-4cb4-8562-c0f714c3daf1)
    Message: Network map updated
    Time: 8 hours, 51 minutes ago
OS: linux/arm64
Daemon version: 0.65.1
CLI version: 0.65.1
Profile: default
Management: Connected to https://mink.danielgal.eu:443
Signal: Connected to https://mink.danielgal.eu:443
Relays:
  [stun:mink.danielgal.eu:3478] is Checking...
  [rels://mink.danielgal.eu:443] is Available
Nameservers:
FQDN: pi.mink.danielgal.eu
NetBird IP: 100.90.167.160/16
Interface type: Kernel
Quantum resistance: false
Lazy connection: false
SSH Server: Disabled
Networks: -
Peers count: 2/2 Connected
```

If your NetBird version does not support `--detail`, paste that error.

### 9) DNS resolution for the app name

Command:

```bash
getent hosts ytdl.mink.lan
resolvectl query ytdl.mink.lan
```

Paste output here:

```text
den@pi:~$ getent hosts ytdl.mink.lan
100.90.167.160  ytdl.mink.lan

den@pi:~$ resolvectl query ytdl.mink.lan
ytdl.mink.lan: Name 'ytdl.mink.lan' not found
```

### 10) Firewall / NAT rules

Command:

```bash
sudo nft list ruleset
sudo iptables-save
sudo ip6tables-save
```

Paste output here:

```text
den@pi:~$ sudo nft list ruleset
table ip6 mangle {
        chain KUBE-PROXY-CANARY {
        }

        chain KUBE-IPTABLES-HINT {
        }

        chain KUBE-KUBELET-CANARY {
        }
}
table ip mangle {
        chain KUBE-PROXY-CANARY {
        }

        chain KUBE-IPTABLES-HINT {
        }

        chain KUBE-KUBELET-CANARY {
        }
}
# Warning: table ip6 nat is managed by iptables-nft, do not touch!
table ip6 nat {
        chain KUBE-PROXY-CANARY {
        }

        chain KUBE-SERVICES {
                ip6 daddr != ::1  fib daddr type local counter packets 3 bytes 522 jump KUBE-NODEPORTS
        }

        chain OUTPUT {
                type nat hook output priority dstnat; policy accept;
                 counter packets 5557 bytes 493958 jump KUBE-SERVICES
        }

        chain PREROUTING {
                type nat hook prerouting priority dstnat; policy accept;
                 counter packets 8275 bytes 1427747 jump KUBE-SERVICES
        }

        chain KUBE-POSTROUTING {
                meta mark & 0x00004000 != 0x00004000 counter packets 76 bytes 6132 return
                counter packets 0 bytes 0 meta mark set mark xor 0x4000
                 counter packets 0 bytes 0 masquerade fully-random
        }

        chain POSTROUTING {
                type nat hook postrouting priority srcnat; policy accept;
                 counter packets 5557 bytes 493958 jump KUBE-POSTROUTING
        }

        chain KUBE-NODEPORTS {
        }

        chain KUBE-MARK-MASQ {
                counter packets 0 bytes 0 meta mark set mark or 0x4000
        }

        chain KUBE-KUBELET-CANARY {
        }
}
# Warning: table ip nat is managed by iptables-nft, do not touch!
table ip nat {
        chain KUBE-PROXY-CANARY {
        }

        chain KUBE-SERVICES {
                ip daddr 10.43.85.149 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-SVC-CVG3OEGEH7H5P3HQ
                ip daddr 100.90.167.160 ip protocol tcp  tcp dport 443 counter packets 9 bytes 540 jump KUBE-EXT-CVG3OEGEH7H5P3HQ
                ip daddr 10.43.111.105 ip protocol tcp  tcp dport 6379 counter packets 0 bytes 0 jump KUBE-SVC-OKJCEJEOAS2LLIDR
                ip daddr 10.43.0.10 ip protocol tcp  tcp dport 53 counter packets 0 bytes 0 jump KUBE-SVC-ERIFXISQEP7F7OF4
                ip daddr 10.43.63.99 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-WOUR72QKFKEYR5ZG
                ip daddr 10.43.85.149 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-UQMCRMJZLI3FTLDP
                ip daddr 100.90.167.160 ip protocol tcp  tcp dport 80 counter packets 13 bytes 780 jump KUBE-EXT-UQMCRMJZLI3FTLDP
                ip daddr 10.43.158.42 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-R462G7DIGADMZDEZ
                ip daddr 10.43.188.231 ip protocol tcp  tcp dport 5000 counter packets 0 bytes 0 jump KUBE-SVC-UHY5YTYXWYGJMWN5
                ip daddr 10.43.0.1 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-SVC-NPX46M4PTMTKRN6Y
                ip daddr 10.43.151.224 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-SVC-Z4ANX4WAEWEBLCTM
                ip daddr 10.43.11.157 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-I7ZLXZTKXA3L3TZN
                ip daddr 10.43.112.136 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-SVC-OSA2NXMW2NNWNEVJ
                ip daddr 10.43.181.51 ip protocol udp  udp dport 1900 counter packets 0 bytes 0 jump KUBE-SVC-5TL63OHMAKD6HCC7
                ip daddr 10.43.0.10 ip protocol tcp  tcp dport 9153 counter packets 0 bytes 0 jump KUBE-SVC-JD5MR3NA4I4DYORP
                ip daddr 10.43.0.10 ip protocol udp  udp dport 53 counter packets 8 bytes 604 jump KUBE-SVC-TCOU7JCQXEZGVUNU
                 fib daddr type local counter packets 2363 bytes 191901 jump KUBE-NODEPORTS
        }

        chain OUTPUT {
                type nat hook output priority dstnat; policy accept;
                 counter packets 4174564 bytes 283828582 jump KUBE-SERVICES
                fib daddr type local counter packets 1098490 bytes 76918261 jump CNI-HOSTPORT-DNAT
        }

        chain PREROUTING {
                type nat hook prerouting priority dstnat; policy accept;
                 counter packets 210387 bytes 52977354 jump KUBE-SERVICES
                fib daddr type local counter packets 140078 bytes 42277398 jump CNI-HOSTPORT-DNAT
        }

        chain KUBE-POSTROUTING {
                meta mark & 0x00004000 != 0x00004000 counter packets 6759 bytes 471538 return
                counter packets 0 bytes 0 meta mark set mark xor 0x4000
                 counter packets 0 bytes 0 # Warning: XT target MASQUERADE not found
xt target "MASQUERADE"
        }

        chain POSTROUTING {
                type nat hook postrouting priority srcnat; policy accept;
                 counter packets 4192016 bytes 285114086 jump CNI-HOSTPORT-MASQ
                 counter packets 4191886 bytes 285108721 jump KUBE-POSTROUTING
                 counter packets 4189137 bytes 284934897 jump FLANNEL-POSTRTG
        }

        chain KUBE-NODEPORTS {
                ip protocol tcp  tcp dport 30080 counter packets 0 bytes 0 jump KUBE-EXT-R462G7DIGADMZDEZ
                ip protocol tcp  tcp dport 30500 counter packets 0 bytes 0 jump KUBE-EXT-UHY5YTYXWYGJMWN5
                ip protocol udp  udp dport 32197 counter packets 0 bytes 0 jump KUBE-EXT-5TL63OHMAKD6HCC7
        }

        chain KUBE-MARK-MASQ {
                counter packets 22 bytes 1320 meta mark set mark or 0x4000
        }

        chain KUBE-SVC-ERIFXISQEP7F7OF4 {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.10 ip protocol tcp  tcp dport 53 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-SPW6OHKWQYLI5PJR
        }

        chain KUBE-SEP-SPW6OHKWQYLI5PJR {
                ip saddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SVC-NPX46M4PTMTKRN6Y {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.1 ip protocol tcp  tcp dport 443 counter packets 22 bytes 1320 jump KUBE-MARK-MASQ
                 counter packets 81 bytes 4860 jump KUBE-SEP-B5VO6EBO7JWDMZQ2
        }

        chain KUBE-SEP-B5VO6EBO7JWDMZQ2 {
                ip saddr 192.168.1.105  counter packets 22 bytes 1320 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 81 bytes 4860 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SVC-JD5MR3NA4I4DYORP {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.10 ip protocol tcp  tcp dport 9153 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-2RAD5WKGWNVHY3DH
        }

        chain KUBE-SEP-2RAD5WKGWNVHY3DH {
                ip saddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SVC-TCOU7JCQXEZGVUNU {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.0.10 ip protocol udp  udp dport 53 counter packets 198 bytes 16046 jump KUBE-MARK-MASQ
                 counter packets 9795 bytes 819185 jump KUBE-SEP-4SSQDR46DMIXOOUO
        }

        chain KUBE-SEP-4SSQDR46DMIXOOUO {
                ip saddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol udp   counter packets 9795 bytes 819185 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-KUBELET-CANARY {
        }

        chain FLANNEL-POSTRTG {
                meta mark & 0x00004000 == 0x00004000  counter packets 0 bytes 0 return
                ip saddr 10.42.0.0/24 ip daddr 10.42.0.0/16  counter packets 2966724 bytes 178230759 return
                ip saddr 10.42.0.0/16 ip daddr 10.42.0.0/24  counter packets 0 bytes 0 return
                ip saddr != 10.42.0.0/16 ip daddr 10.42.0.0/24  counter packets 0 bytes 0 return
                ip saddr 10.42.0.0/16 ip daddr != 224.0.0.0/4  counter packets 38894 bytes 13196036 # Warning: XT target MASQUERADE not found
xt target "MASQUERADE"
                ip saddr != 10.42.0.0/16 ip daddr 10.42.0.0/16  counter packets 0 bytes 0 # Warning: XT target MASQUERADE not found
xt target "MASQUERADE"
        }

        chain CNI-HOSTPORT-SETMARK {
                 counter packets 2 bytes 120 meta mark set mark or 0x2000
        }

        chain CNI-HOSTPORT-MASQ {
                meta mark & 0x00002000 == 0x00002000 counter packets 179 bytes 12508 # Warning: XT target MASQUERADE not found
xt target "MASQUERADE"
        }

        chain CNI-HOSTPORT-DNAT {
        }

        chain KUBE-SVC-Z4ANX4WAEWEBLCTM {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.151.224 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-EQF7TPGZGAONTLYZ
        }

        chain KUBE-SEP-EQF7TPGZGAONTLYZ {
                ip saddr 10.42.0.5  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-EXT-UHY5YTYXWYGJMWN5 {
                 counter packets 1227 bytes 73620 jump KUBE-MARK-MASQ
                counter packets 1227 bytes 73620 jump KUBE-SVC-UHY5YTYXWYGJMWN5
        }

        chain KUBE-SVC-UHY5YTYXWYGJMWN5 {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.188.231 ip protocol tcp  tcp dport 5000 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 1227 bytes 73620 jump KUBE-SEP-47TYL3K3JWJ36POJ
        }

        chain KUBE-SEP-47TYL3K3JWJ36POJ {
                ip saddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 1227 bytes 73620 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SVC-OKJCEJEOAS2LLIDR {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.111.105 ip protocol tcp  tcp dport 6379 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 108 bytes 6480 jump KUBE-SEP-GP4EVLOCJ42DFVEM
        }

        chain KUBE-SEP-GP4EVLOCJ42DFVEM {
                ip saddr 10.42.0.11  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 108 bytes 6480 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-EXT-R462G7DIGADMZDEZ {
                 counter packets 7 bytes 420 jump KUBE-MARK-MASQ
                counter packets 7 bytes 420 jump KUBE-SVC-R462G7DIGADMZDEZ
        }

        chain KUBE-SVC-R462G7DIGADMZDEZ {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.158.42 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 7 bytes 420 jump KUBE-SEP-OZMNHHTNYIHMU5QA
        }

        chain KUBE-SEP-OZMNHHTNYIHMU5QA {
                ip saddr 192.168.1.105  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 7 bytes 420 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-EXT-5TL63OHMAKD6HCC7 {
                 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                counter packets 0 bytes 0 jump KUBE-SVC-5TL63OHMAKD6HCC7
        }

        chain KUBE-SVC-5TL63OHMAKD6HCC7 {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.181.51 ip protocol udp  udp dport 1900 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-PQ2LHDKKDGM72FNX
        }

        chain KUBE-SEP-PQ2LHDKKDGM72FNX {
                ip saddr 192.168.1.105  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol udp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SVC-I7ZLXZTKXA3L3TZN {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.11.157 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-IG67G5W4T7S4OGEE
        }

        chain KUBE-SVC-OSA2NXMW2NNWNEVJ {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.112.136 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-TVJD5O64HPGUK6P4
        }

        chain KUBE-SEP-TVJD5O64HPGUK6P4 {
                ip saddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SEP-IG67G5W4T7S4OGEE {
                ip saddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SVC-WOUR72QKFKEYR5ZG {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.63.99 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 0 bytes 0 jump KUBE-SEP-OG25TDWD2DXFZRMA
        }

        chain KUBE-EXT-UQMCRMJZLI3FTLDP {
                 counter packets 33 bytes 1980 jump KUBE-MARK-MASQ
                counter packets 33 bytes 1980 jump KUBE-SVC-UQMCRMJZLI3FTLDP
        }

        chain KUBE-SVC-UQMCRMJZLI3FTLDP {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.85.149 ip protocol tcp  tcp dport 80 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 33 bytes 1980 jump KUBE-SEP-G64LDQDZAJHDGIT6
        }

        chain KUBE-SEP-G64LDQDZAJHDGIT6 {
                ip saddr 192.168.1.105  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 33 bytes 1980 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-EXT-CVG3OEGEH7H5P3HQ {
                 counter packets 14 bytes 840 jump KUBE-MARK-MASQ
                counter packets 14 bytes 840 jump KUBE-SVC-CVG3OEGEH7H5P3HQ
        }

        chain KUBE-SVC-CVG3OEGEH7H5P3HQ {
                ip saddr != 10.42.0.0/16 ip daddr 10.43.85.149 ip protocol tcp  tcp dport 443 counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                 counter packets 14 bytes 840 jump KUBE-SEP-QEVIGMRENYKM2NRG
        }

        chain KUBE-SEP-QEVIGMRENYKM2NRG {
                ip saddr 192.168.1.105  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 14 bytes 840 # Warning: XT target DNAT not found
xt target "DNAT"
        }

        chain KUBE-SEP-OG25TDWD2DXFZRMA {
                ip saddr 10.42.0.51  counter packets 0 bytes 0 jump KUBE-MARK-MASQ
                ip protocol tcp   counter packets 0 bytes 0 # Warning: XT target DNAT not found
xt target "DNAT"
        }
}
# Warning: table ip6 filter is managed by iptables-nft, do not touch!
table ip6 filter {
        chain KUBE-PROXY-CANARY {
        }

        chain KUBE-EXTERNAL-SERVICES {
        }

        chain INPUT {
                type filter hook input priority filter; policy accept;
                counter packets 478144 bytes 733011549 jump KUBE-FIREWALL
                ct state new  counter packets 43798 bytes 9804693 jump KUBE-PROXY-FIREWALL
                 counter packets 478144 bytes 733011549 jump KUBE-NODEPORTS
                ct state new  counter packets 43798 bytes 9804693 jump KUBE-EXTERNAL-SERVICES
        }

        chain FORWARD {
                type filter hook forward priority filter; policy accept;
                ct state new  counter packets 0 bytes 0 jump KUBE-PROXY-FIREWALL
                 counter packets 100376 bytes 5672116 jump KUBE-FORWARD
                ct state new  counter packets 0 bytes 0 jump KUBE-SERVICES
                ct state new  counter packets 0 bytes 0 jump KUBE-EXTERNAL-SERVICES
        }

        chain KUBE-NODEPORTS {
        }

        chain KUBE-SERVICES {
        }

        chain OUTPUT {
                type filter hook output priority filter; policy accept;
                counter packets 233612 bytes 18602363 jump KUBE-FIREWALL
                ct state new  counter packets 7193 bytes 663169 jump KUBE-PROXY-FIREWALL
                ct state new  counter packets 7193 bytes 663169 jump KUBE-SERVICES
        }

        chain KUBE-FORWARD {
                ct state invalid counter packets 0 bytes 0 drop
                 meta mark & 0x00004000 == 0x00004000 counter packets 0 bytes 0 accept
                 ct state related,established counter packets 0 bytes 0 accept
        }

        chain KUBE-PROXY-FIREWALL {
        }

        chain KUBE-FIREWALL {
        }

        chain KUBE-KUBELET-CANARY {
        }
}
table ip netbird {
        set nb0000001 {
                type ipv4_addr
                flags dynamic
                elements = { 100.90.149.44, 100.90.226.194 }
        }

        chain netbird-rt-fwd {
                ct state established,related counter packets 0 bytes 0 accept
        }

        chain netbird-rt-postrouting {
                type nat hook postrouting priority srcnat - 1; policy accept;
                meta mark 0x0001bd21 oifname != "lo" counter packets 0 bytes 0 masquerade
                meta mark 0x0001bd22 oifname "wt0" counter packets 0 bytes 0 masquerade
        }

        chain netbird-rt-redirect {
                type nat hook prerouting priority dstnat; policy accept;
        }

        chain netbird-mangle-postrouting {
                type filter hook postrouting priority mangle; policy accept;
                oifname "wt0" ct state new ct mark set 0x0001bd11
        }

        chain netbird-mangle-prerouting {
                type filter hook prerouting priority mangle; policy accept;
                iifname "wt0" ct state new ct mark set 0x0001bd10
                iifname "wt0" ip saddr @nb0000001 fib daddr type local meta mark set 0x0001bd20
        }

        chain netbird-mangle-forward {
                type filter hook forward priority mangle; policy accept;
                oifname "wt0" tcp flags syn counter packets 0 bytes 0 tcp option maxseg size > 1240 tcp option maxseg size set 1240
        }

        chain netbird-acl-input-rules {
                ct state established,related counter packets 2829 bytes 284433 accept
                ip saddr @nb0000001 accept
        }

        chain netbird-acl-input-filter {
                type filter hook input priority filter; policy accept;
                iifname "wt0" jump netbird-acl-input-rules
                iifname "wt0" drop
        }

        chain netbird-acl-forward-filter {
                type filter hook forward priority filter; policy accept;
                meta mark 0x0001bd20 accept
                iifname "wt0" jump netbird-rt-fwd
                iifname "wt0" drop
        }

        chain netbird-raw-out {
                type filter hook output priority raw; policy accept;
                oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 udp sport 51820 counter packets 1236 bytes 870960 notrack
                oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 udp dport 51820 counter packets 1222 bytes 217756 notrack
        }

        chain netbird-raw-pre {
                type filter hook prerouting priority raw; policy accept;
                iifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 udp dport 51820 counter packets 1222 bytes 217756 notrack
                iifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 udp dport 3128 counter packets 1236 bytes 870960 notrack
        }
}
table inet netbird_wt0 {
        chain input {
                type filter hook input priority filter; policy accept;
                iifname "wt0" tcp dport { 80, 443 } accept
        }
}
# Warning: table ip filter is managed by iptables-nft, do not touch!
table ip filter {
        chain INPUT {
                type filter hook input priority filter; policy accept;
                 counter packets 7731 bytes 1916173 jump KUBE-ROUTER-INPUT
                iifname "wt0" counter packets 32 bytes 2576 accept
                counter packets 5711 bytes 1453640 jump KUBE-FIREWALL
                ct state new  counter packets 278 bytes 68766 jump KUBE-PROXY-FIREWALL
                 counter packets 5711 bytes 1453640 jump KUBE-NODEPORTS
                ct state new  counter packets 278 bytes 68766 jump KUBE-EXTERNAL-SERVICES
                 meta mark & 0x00020000 == 0x00020000 counter packets 0 bytes 0 accept
        }

        chain FORWARD {
                type filter hook forward priority filter; policy accept;
                 counter packets 761 bytes 165927 jump KUBE-ROUTER-FORWARD
                oifname "wt0" ct state related,established counter packets 0 bytes 0 accept
                iifname "wt0" counter packets 0 bytes 0 accept
                ct state new  counter packets 0 bytes 0 jump KUBE-PROXY-FIREWALL
                 counter packets 0 bytes 0 jump KUBE-FORWARD
                ct state new  counter packets 0 bytes 0 jump KUBE-SERVICES
                ct state new  counter packets 0 bytes 0 jump KUBE-EXTERNAL-SERVICES
                 meta mark & 0x00020000 == 0x00020000 counter packets 0 bytes 0 accept
                 counter packets 0 bytes 0 jump FLANNEL-FWD
        }

        chain OUTPUT {
                type filter hook output priority filter; policy accept;
                 counter packets 7894 bytes 1867329 jump KUBE-ROUTER-OUTPUT
                counter packets 5702 bytes 1520338 jump KUBE-FIREWALL
                ct state new  counter packets 266 bytes 53945 jump KUBE-PROXY-FIREWALL
                ct state new  counter packets 266 bytes 53945 jump KUBE-SERVICES
                 meta mark & 0x00020000 == 0x00020000 counter packets 0 bytes 0 accept
        }

        chain FLANNEL-FWD {
                ip saddr 10.42.0.0/16  counter packets 0 bytes 0 accept
                ip daddr 10.42.0.0/16  counter packets 0 bytes 0 accept
        }

        chain KUBE-EXTERNAL-SERVICES {
        }

        chain KUBE-FIREWALL {
                ip saddr != 127.0.0.0/8 ip daddr 127.0.0.0/8  ct status dnat counter packets 0 bytes 0 drop
        }

        chain KUBE-FORWARD {
                ct state invalid counter packets 0 bytes 0 drop
                 meta mark & 0x00004000 == 0x00004000 counter packets 0 bytes 0 accept
                 ct state related,established counter packets 0 bytes 0 accept
        }

        chain KUBE-KUBELET-CANARY {
        }

        chain KUBE-NODEPORTS {
        }

        chain KUBE-NWPLCY-DEFAULT {
                ip protocol icmp  icmp type echo-request counter packets 0 bytes 0 accept
                ip protocol icmp  icmp type destination-unreachable counter packets 0 bytes 0 accept
                ip protocol icmp  icmp type time-exceeded counter packets 0 bytes 0 accept
                 counter packets 0 bytes 0 meta mark set mark or 0x10000
        }

        chain KUBE-PROXY-CANARY {
        }

        chain KUBE-PROXY-FIREWALL {
        }

        chain KUBE-ROUTER-FORWARD {
                ip daddr 10.42.0.9  counter packets 0 bytes 0 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip daddr 10.42.0.9 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip saddr 10.42.0.9  counter packets 0 bytes 0 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip saddr 10.42.0.9 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip daddr 10.42.0.51  counter packets 80 bytes 66384 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip daddr 10.42.0.51 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip saddr 10.42.0.51  counter packets 112 bytes 10008 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip saddr 10.42.0.51 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip daddr 10.42.0.11  counter packets 292 bytes 72896 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip daddr 10.42.0.11 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip saddr 10.42.0.11  counter packets 277 bytes 16639 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip saddr 10.42.0.11 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip daddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip daddr 10.42.0.7 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip saddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip saddr 10.42.0.7 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip daddr 10.42.0.6  counter packets 0 bytes 0 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip daddr 10.42.0.6 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip saddr 10.42.0.6  counter packets 0 bytes 0 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip saddr 10.42.0.6 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip daddr 10.42.0.5  counter packets 0 bytes 0 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip daddr 10.42.0.5 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip saddr 10.42.0.5  counter packets 0 bytes 0 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip saddr 10.42.0.5 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip daddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip daddr 10.42.0.52 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip saddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip saddr 10.42.0.52 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip daddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip daddr 10.42.0.31 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip saddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip saddr 10.42.0.31 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip daddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip daddr 10.42.0.32 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip saddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip saddr 10.42.0.32 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip daddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip daddr 10.42.0.29 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip saddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip saddr 10.42.0.29 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip daddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
                ip daddr 10.42.0.10 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
                ip saddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
                ip saddr 10.42.0.10 xt match "physdev"  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
        }

        chain KUBE-ROUTER-INPUT {
                ip daddr 10.43.0.0/16  counter packets 0 bytes 0 return
                ip protocol tcp  fib daddr type local tcp dport 30000-32767 counter packets 0 bytes 0 return
                ip protocol udp  fib daddr type local udp dport 30000-32767 counter packets 0 bytes 0 return
                ip saddr 10.42.0.9  counter packets 475 bytes 92677 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip saddr 10.42.0.51  counter packets 29 bytes 27366 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip saddr 10.42.0.11  counter packets 0 bytes 0 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip saddr 10.42.0.7  counter packets 444 bytes 35772 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip saddr 10.42.0.6  counter packets 19 bytes 1329 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip saddr 10.42.0.5  counter packets 1021 bytes 302813 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip saddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip saddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip saddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip saddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip saddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
        }

        chain KUBE-ROUTER-OUTPUT {
                ip daddr 10.42.0.9  counter packets 404 bytes 154356 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip saddr 10.42.0.9  counter packets 0 bytes 0 jump KUBE-POD-FW-744N4G3CSHQ7EBH6
                ip daddr 10.42.0.51  counter packets 29 bytes 5894 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip saddr 10.42.0.51  counter packets 0 bytes 0 jump KUBE-POD-FW-NDYZZHB43LM3WHMG
                ip daddr 10.42.0.11  counter packets 0 bytes 0 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip saddr 10.42.0.11  counter packets 0 bytes 0 jump KUBE-POD-FW-73LJ5GV6YPECDA73
                ip daddr 10.42.0.7  counter packets 512 bytes 37705 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip saddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-POD-FW-2LFS5P7CSIC6IATF
                ip daddr 10.42.0.6  counter packets 15 bytes 2928 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip saddr 10.42.0.6  counter packets 0 bytes 0 jump KUBE-POD-FW-JBL33G5ZDL74JGRO
                ip daddr 10.42.0.5  counter packets 1232 bytes 146108 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip saddr 10.42.0.5  counter packets 0 bytes 0 jump KUBE-POD-FW-Z5IQ3DL5NGTZE6LV
                ip daddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip saddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-POD-FW-H7Q3AKXN3PRBWQZU
                ip daddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip saddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-POD-FW-YZDW5JUZM5KAF7GW
                ip daddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip saddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-POD-FW-UPLFTEDPXD5F2WUR
                ip daddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip saddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-POD-FW-NLZS7MZHIW6QO722
                ip daddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
                ip saddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-POD-FW-4Z2EY2JNEOEJ5AR5
        }

        chain KUBE-SERVICES {
        }

        chain KUBE-POD-FW-744N4G3CSHQ7EBH6 {
                 ct state related,established counter packets 879 bytes 247033 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.9  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.9  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.9  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-NDYZZHB43LM3WHMG {
                 ct state related,established counter packets 245 bytes 109352 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.51  fib saddr type local counter packets 5 bytes 300 accept
                ip saddr 10.42.0.51  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.51  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-73LJ5GV6YPECDA73 {
                 ct state related,established counter packets 569 bytes 89535 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.11  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.11  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.11  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-2LFS5P7CSIC6IATF {
                 ct state related,established counter packets 870 bytes 68317 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.7  fib saddr type local counter packets 86 bytes 5160 accept
                ip saddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.7  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-JBL33G5ZDL74JGRO {
                 ct state related,established counter packets 34 bytes 4257 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.6  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.6  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.6  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-Z5IQ3DL5NGTZE6LV {
                 ct state related,established counter packets 2166 bytes 443701 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.5  fib saddr type local counter packets 87 bytes 5220 accept
                ip saddr 10.42.0.5  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.5  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-H7Q3AKXN3PRBWQZU {
                 ct state related,established counter packets 0 bytes 0 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.52  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.52  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-YZDW5JUZM5KAF7GW {
                 ct state related,established counter packets 0 bytes 0 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.31  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.31  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-UPLFTEDPXD5F2WUR {
                 ct state related,established counter packets 0 bytes 0 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.32  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.32  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-NLZS7MZHIW6QO722 {
                 ct state related,established counter packets 0 bytes 0 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.29  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.29  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }

        chain KUBE-POD-FW-4Z2EY2JNEOEJ5AR5 {
                 ct state related,established counter packets 0 bytes 0 accept
                 ct state invalid counter packets 0 bytes 0 drop
                ip daddr 10.42.0.10  fib saddr type local counter packets 0 bytes 0 accept
                ip saddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                ip daddr 10.42.0.10  counter packets 0 bytes 0 jump KUBE-NWPLCY-DEFAULT
                 meta mark & 0x00010000 != 0x00010000 limit rate 10/minute burst 10 packets counter packets 0 bytes 0 log group 100
                 meta mark & 0x00010000 != 0x00010000 counter packets 0 bytes 0 reject
                counter packets 0 bytes 0 meta mark set mark and 0xfffeffff
                 counter packets 0 bytes 0 meta mark set mark or 0x20000
        }
}

den@pi:~$ sudo iptables-save
# Generated by iptables-save v1.8.10 (nf_tables) on Sat Mar  7 09:25:55 2026
*mangle
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
:KUBE-IPTABLES-HINT - [0:0]
:KUBE-KUBELET-CANARY - [0:0]
:KUBE-PROXY-CANARY - [0:0]
COMMIT
# Completed on Sat Mar  7 09:25:55 2026
# Generated by iptables-save v1.8.10 (nf_tables) on Sat Mar  7 09:25:55 2026
*filter
:INPUT ACCEPT [114:25368]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [110:24969]
:FLANNEL-FWD - [0:0]
:KUBE-EXTERNAL-SERVICES - [0:0]
:KUBE-FIREWALL - [0:0]
:KUBE-FORWARD - [0:0]
:KUBE-KUBELET-CANARY - [0:0]
:KUBE-NODEPORTS - [0:0]
:KUBE-NWPLCY-DEFAULT - [0:0]
:KUBE-POD-FW-4BDGZEWEU32YM75H - [0:0]
:KUBE-POD-FW-5SIOAJNH6ODJP6UR - [0:0]
:KUBE-POD-FW-5SQ445J7JCHXDGWH - [0:0]
:KUBE-POD-FW-BCVX7G6KP6NQTAHS - [0:0]
:KUBE-POD-FW-FIHYK2JPCHEKEZ7Z - [0:0]
:KUBE-POD-FW-KGZXVWTG6NN7TQSS - [0:0]
:KUBE-POD-FW-MCEX7YJKJ5JX3N2B - [0:0]
:KUBE-POD-FW-PR4SGQTSGSUF4GCW - [0:0]
:KUBE-POD-FW-QRTHZDYKIP23WRGD - [0:0]
:KUBE-POD-FW-RZC3GPYPRBHWCLX6 - [0:0]
:KUBE-POD-FW-Y4RYQMHPC236MTDC - [0:0]
:KUBE-PROXY-CANARY - [0:0]
:KUBE-PROXY-FIREWALL - [0:0]
:KUBE-ROUTER-FORWARD - [0:0]
:KUBE-ROUTER-INPUT - [0:0]
:KUBE-ROUTER-OUTPUT - [0:0]
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
-A KUBE-POD-FW-4BDGZEWEU32YM75H -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-4BDGZEWEU32YM75H -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-4BDGZEWEU32YM75H -d 10.42.0.11/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-4BDGZEWEU32YM75H -s 10.42.0.11/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-4BDGZEWEU32YM75H -d 10.42.0.11/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-4BDGZEWEU32YM75H -m comment --comment "rule to log dropped traffic POD name:redis-84f85f9cdc-nfbl2 namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-4BDGZEWEU32YM75H -m comment --comment "rule to REJECT traffic destined for POD name:redis-84f85f9cdc-nfbl2 namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-4BDGZEWEU32YM75H -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-4BDGZEWEU32YM75H -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -d 10.42.0.52/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -s 10.42.0.52/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -d 10.42.0.52/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -m comment --comment "rule to log dropped traffic POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -m comment --comment "rule to REJECT traffic destined for POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-5SIOAJNH6ODJP6UR -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -d 10.42.0.7/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -s 10.42.0.7/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -d 10.42.0.7/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -m comment --comment "rule to log dropped traffic POD name:coredns-7b98449c4-ghtp8 namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -m comment --comment "rule to REJECT traffic destined for POD name:coredns-7b98449c4-ghtp8 namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-5SQ445J7JCHXDGWH -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -d 10.42.0.10/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -s 10.42.0.10/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -d 10.42.0.10/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -m comment --comment "rule to log dropped traffic POD name:registry-7cb844c9cd-ztqk4 namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -m comment --comment "rule to REJECT traffic destined for POD name:registry-7cb844c9cd-ztqk4 namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-BCVX7G6KP6NQTAHS -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -d 10.42.0.31/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -s 10.42.0.31/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -d 10.42.0.31/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -m comment --comment "rule to log dropped traffic POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -m comment --comment "rule to REJECT traffic destined for POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-FIHYK2JPCHEKEZ7Z -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -d 10.42.0.51/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -s 10.42.0.51/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -d 10.42.0.51/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -m comment --comment "rule to log dropped traffic POD name:ytdl-576d886644-qwg9l namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -m comment --comment "rule to REJECT traffic destined for POD name:ytdl-576d886644-qwg9l namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-KGZXVWTG6NN7TQSS -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -d 10.42.0.29/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -s 10.42.0.29/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -d 10.42.0.29/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -m comment --comment "rule to log dropped traffic POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -m comment --comment "rule to REJECT traffic destined for POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-MCEX7YJKJ5JX3N2B -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -d 10.42.0.9/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -s 10.42.0.9/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -d 10.42.0.9/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -m comment --comment "rule to log dropped traffic POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -m comment --comment "rule to REJECT traffic destined for POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-PR4SGQTSGSUF4GCW -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -d 10.42.0.32/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -s 10.42.0.32/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -d 10.42.0.32/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -m comment --comment "rule to log dropped traffic POD name:sumnivore-6ffd56fdd-wbgkf namespace: default" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -m comment --comment "rule to REJECT traffic destined for POD name:sumnivore-6ffd56fdd-wbgkf namespace: default" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-QRTHZDYKIP23WRGD -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -d 10.42.0.6/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -s 10.42.0.6/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -d 10.42.0.6/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -m comment --comment "rule to log dropped traffic POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -m comment --comment "rule to REJECT traffic destined for POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-RZC3GPYPRBHWCLX6 -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -m comment --comment "rule for stateful firewall for pod" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -m comment --comment "rule to drop invalid state for pod" -m conntrack --ctstate INVALID -j DROP
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -d 10.42.0.5/32 -m comment --comment "rule to permit the traffic traffic to pods when source is the pod\'s local node" -m addrtype --src-type LOCAL -j ACCEPT
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -s 10.42.0.5/32 -m comment --comment "run through default egress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -d 10.42.0.5/32 -m comment --comment "run through default ingress network policy chain" -j KUBE-NWPLCY-DEFAULT
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -m comment --comment "rule to log dropped traffic POD name:metrics-server-cdcc87586-phckc namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -m limit --limit 10/min --limit-burst 10 -j NFLOG --nflog-group 100
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -m comment --comment "rule to REJECT traffic destined for POD name:metrics-server-cdcc87586-phckc namespace: kube-system" -m mark ! --mark 0x10000/0x10000 -j REJECT --reject-with icmp-port-unreachable
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -j MARK --set-xmark 0x0/0x10000
-A KUBE-POD-FW-Y4RYQMHPC236MTDC -m comment --comment "set mark to ACCEPT traffic that comply to network policies" -j MARK --set-xmark 0x20000/0x20000
-A KUBE-ROUTER-FORWARD -d 10.42.0.31/32 -m comment --comment "rule to jump traffic destined to POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-FORWARD -d 10.42.0.31/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-FORWARD -s 10.42.0.31/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-FORWARD -s 10.42.0.31/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-FORWARD -d 10.42.0.11/32 -m comment --comment "rule to jump traffic destined to POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-FORWARD -d 10.42.0.11/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-FORWARD -s 10.42.0.11/32 -m comment --comment "rule to jump traffic from POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-FORWARD -s 10.42.0.11/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-FORWARD -d 10.42.0.29/32 -m comment --comment "rule to jump traffic destined to POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-FORWARD -d 10.42.0.29/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-FORWARD -s 10.42.0.29/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-FORWARD -s 10.42.0.29/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-FORWARD -d 10.42.0.32/32 -m comment --comment "rule to jump traffic destined to POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-FORWARD -d 10.42.0.32/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-FORWARD -s 10.42.0.32/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-FORWARD -s 10.42.0.32/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-FORWARD -d 10.42.0.9/32 -m comment --comment "rule to jump traffic destined to POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-FORWARD -d 10.42.0.9/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-FORWARD -s 10.42.0.9/32 -m comment --comment "rule to jump traffic from POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-FORWARD -s 10.42.0.9/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-FORWARD -d 10.42.0.6/32 -m comment --comment "rule to jump traffic destined to POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-FORWARD -d 10.42.0.6/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-FORWARD -s 10.42.0.6/32 -m comment --comment "rule to jump traffic from POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-FORWARD -s 10.42.0.6/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-FORWARD -d 10.42.0.52/32 -m comment --comment "rule to jump traffic destined to POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-FORWARD -d 10.42.0.52/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-FORWARD -s 10.42.0.52/32 -m comment --comment "rule to jump traffic from POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-FORWARD -s 10.42.0.52/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-FORWARD -d 10.42.0.5/32 -m comment --comment "rule to jump traffic destined to POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-FORWARD -d 10.42.0.5/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-FORWARD -s 10.42.0.5/32 -m comment --comment "rule to jump traffic from POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-FORWARD -s 10.42.0.5/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-FORWARD -d 10.42.0.51/32 -m comment --comment "rule to jump traffic destined to POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-FORWARD -d 10.42.0.51/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-FORWARD -s 10.42.0.51/32 -m comment --comment "rule to jump traffic from POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-FORWARD -s 10.42.0.51/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-FORWARD -d 10.42.0.10/32 -m comment --comment "rule to jump traffic destined to POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-FORWARD -d 10.42.0.10/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-FORWARD -s 10.42.0.10/32 -m comment --comment "rule to jump traffic from POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-FORWARD -s 10.42.0.10/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-FORWARD -d 10.42.0.7/32 -m comment --comment "rule to jump traffic destined to POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
-A KUBE-ROUTER-FORWARD -d 10.42.0.7/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic destined to POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
-A KUBE-ROUTER-FORWARD -s 10.42.0.7/32 -m comment --comment "rule to jump traffic from POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
-A KUBE-ROUTER-FORWARD -s 10.42.0.7/32 -m physdev --physdev-is-bridged -m comment --comment "rule to jump traffic from POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
-A KUBE-ROUTER-INPUT -d 10.43.0.0/16 -m comment --comment "allow traffic to primary/secondary cluster IP range - EKROEGTNIJ3AP3LC" -j RETURN
-A KUBE-ROUTER-INPUT -p tcp -m comment --comment "allow LOCAL TCP traffic to node ports - LR7XO7NXDBGQJD2M" -m addrtype --dst-type LOCAL -m multiport --dports 30000:32767 -j RETURN
-A KUBE-ROUTER-INPUT -p udp -m comment --comment "allow LOCAL UDP traffic to node ports - 76UCBPIZNGJNWNUZ" -m addrtype --dst-type LOCAL -m multiport --dports 30000:32767 -j RETURN
-A KUBE-ROUTER-INPUT -s 10.42.0.31/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-INPUT -s 10.42.0.11/32 -m comment --comment "rule to jump traffic from POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-INPUT -s 10.42.0.29/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-INPUT -s 10.42.0.32/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-INPUT -s 10.42.0.9/32 -m comment --comment "rule to jump traffic from POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-INPUT -s 10.42.0.6/32 -m comment --comment "rule to jump traffic from POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-INPUT -s 10.42.0.52/32 -m comment --comment "rule to jump traffic from POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-INPUT -s 10.42.0.5/32 -m comment --comment "rule to jump traffic from POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-INPUT -s 10.42.0.51/32 -m comment --comment "rule to jump traffic from POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-INPUT -s 10.42.0.10/32 -m comment --comment "rule to jump traffic from POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-INPUT -s 10.42.0.7/32 -m comment --comment "rule to jump traffic from POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
-A KUBE-ROUTER-OUTPUT -d 10.42.0.31/32 -m comment --comment "rule to jump traffic destined to POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-OUTPUT -s 10.42.0.31/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-worker-7884fdf647-jlrmg namespace: default to chain KUBE-POD-FW-FIHYK2JPCHEKEZ7Z" -j KUBE-POD-FW-FIHYK2JPCHEKEZ7Z
-A KUBE-ROUTER-OUTPUT -d 10.42.0.11/32 -m comment --comment "rule to jump traffic destined to POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-OUTPUT -s 10.42.0.11/32 -m comment --comment "rule to jump traffic from POD name:redis-84f85f9cdc-nfbl2 namespace: default to chain KUBE-POD-FW-4BDGZEWEU32YM75H" -j KUBE-POD-FW-4BDGZEWEU32YM75H
-A KUBE-ROUTER-OUTPUT -d 10.42.0.29/32 -m comment --comment "rule to jump traffic destined to POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-OUTPUT -s 10.42.0.29/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-bun-7798d4b669-x6rhh namespace: default to chain KUBE-POD-FW-MCEX7YJKJ5JX3N2B" -j KUBE-POD-FW-MCEX7YJKJ5JX3N2B
-A KUBE-ROUTER-OUTPUT -d 10.42.0.32/32 -m comment --comment "rule to jump traffic destined to POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-OUTPUT -s 10.42.0.32/32 -m comment --comment "rule to jump traffic from POD name:sumnivore-6ffd56fdd-wbgkf namespace: default to chain KUBE-POD-FW-QRTHZDYKIP23WRGD" -j KUBE-POD-FW-QRTHZDYKIP23WRGD
-A KUBE-ROUTER-OUTPUT -d 10.42.0.9/32 -m comment --comment "rule to jump traffic destined to POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-OUTPUT -s 10.42.0.9/32 -m comment --comment "rule to jump traffic from POD name:nfs-provisioner-59b885585d-2klbz namespace: kube-system to chain KUBE-POD-FW-PR4SGQTSGSUF4GCW" -j KUBE-POD-FW-PR4SGQTSGSUF4GCW
-A KUBE-ROUTER-OUTPUT -d 10.42.0.6/32 -m comment --comment "rule to jump traffic destined to POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-OUTPUT -s 10.42.0.6/32 -m comment --comment "rule to jump traffic from POD name:local-path-provisioner-595dcfc56f-fdrtk namespace: kube-system to chain KUBE-POD-FW-RZC3GPYPRBHWCLX6" -j KUBE-POD-FW-RZC3GPYPRBHWCLX6
-A KUBE-ROUTER-OUTPUT -d 10.42.0.52/32 -m comment --comment "rule to jump traffic destined to POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-OUTPUT -s 10.42.0.52/32 -m comment --comment "rule to jump traffic from POD name:ytdl-worker-5dc998fb9d-hfgmb namespace: default to chain KUBE-POD-FW-5SIOAJNH6ODJP6UR" -j KUBE-POD-FW-5SIOAJNH6ODJP6UR
-A KUBE-ROUTER-OUTPUT -d 10.42.0.5/32 -m comment --comment "rule to jump traffic destined to POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-OUTPUT -s 10.42.0.5/32 -m comment --comment "rule to jump traffic from POD name:metrics-server-cdcc87586-phckc namespace: kube-system to chain KUBE-POD-FW-Y4RYQMHPC236MTDC" -j KUBE-POD-FW-Y4RYQMHPC236MTDC
-A KUBE-ROUTER-OUTPUT -d 10.42.0.51/32 -m comment --comment "rule to jump traffic destined to POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-OUTPUT -s 10.42.0.51/32 -m comment --comment "rule to jump traffic from POD name:ytdl-576d886644-qwg9l namespace: default to chain KUBE-POD-FW-KGZXVWTG6NN7TQSS" -j KUBE-POD-FW-KGZXVWTG6NN7TQSS
-A KUBE-ROUTER-OUTPUT -d 10.42.0.10/32 -m comment --comment "rule to jump traffic destined to POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-OUTPUT -s 10.42.0.10/32 -m comment --comment "rule to jump traffic from POD name:registry-7cb844c9cd-ztqk4 namespace: default to chain KUBE-POD-FW-BCVX7G6KP6NQTAHS" -j KUBE-POD-FW-BCVX7G6KP6NQTAHS
-A KUBE-ROUTER-OUTPUT -d 10.42.0.7/32 -m comment --comment "rule to jump traffic destined to POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
-A KUBE-ROUTER-OUTPUT -s 10.42.0.7/32 -m comment --comment "rule to jump traffic from POD name:coredns-7b98449c4-ghtp8 namespace: kube-system to chain KUBE-POD-FW-5SQ445J7JCHXDGWH" -j KUBE-POD-FW-5SQ445J7JCHXDGWH
COMMIT
# Completed on Sat Mar  7 09:25:55 2026
# Generated by iptables-save v1.8.10 (nf_tables) on Sat Mar  7 09:25:55 2026
*nat
:PREROUTING ACCEPT [198774:52055550]
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [4173642:283772711]
:POSTROUTING ACCEPT [4150616:271767778]
:CNI-HOSTPORT-DNAT - [0:0]
:CNI-HOSTPORT-MASQ - [0:0]
:CNI-HOSTPORT-SETMARK - [0:0]
:FLANNEL-POSTRTG - [0:0]
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
:KUBE-SEP-47TYL3K3JWJ36POJ - [0:0]
:KUBE-SEP-4SSQDR46DMIXOOUO - [0:0]
:KUBE-SEP-B5VO6EBO7JWDMZQ2 - [0:0]
:KUBE-SEP-EQF7TPGZGAONTLYZ - [0:0]
:KUBE-SEP-G64LDQDZAJHDGIT6 - [0:0]
:KUBE-SEP-GP4EVLOCJ42DFVEM - [0:0]
:KUBE-SEP-IG67G5W4T7S4OGEE - [0:0]
:KUBE-SEP-OG25TDWD2DXFZRMA - [0:0]
:KUBE-SEP-OZMNHHTNYIHMU5QA - [0:0]
:KUBE-SEP-PQ2LHDKKDGM72FNX - [0:0]
:KUBE-SEP-QEVIGMRENYKM2NRG - [0:0]
:KUBE-SEP-SPW6OHKWQYLI5PJR - [0:0]
:KUBE-SEP-TVJD5O64HPGUK6P4 - [0:0]
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
-A KUBE-NODEPORTS -p tcp -m comment --comment "default/tuby:http" -m tcp --dport 30080 -j KUBE-EXT-R462G7DIGADMZDEZ
-A KUBE-NODEPORTS -p tcp -m comment --comment "default/registry" -m tcp --dport 30500 -j KUBE-EXT-UHY5YTYXWYGJMWN5
-A KUBE-NODEPORTS -p udp -m comment --comment "default/tuby-dlna:dlna-udp" -m udp --dport 32197 -j KUBE-EXT-5TL63OHMAKD6HCC7
-A KUBE-POSTROUTING -m mark ! --mark 0x4000/0x4000 -j RETURN
-A KUBE-POSTROUTING -j MARK --set-xmark 0x4000/0x0
-A KUBE-POSTROUTING -m comment --comment "kubernetes service traffic requiring SNAT" -j MASQUERADE --random-fully
-A KUBE-SEP-2RAD5WKGWNVHY3DH -s 10.42.0.7/32 -m comment --comment "kube-system/kube-dns:metrics" -j KUBE-MARK-MASQ
-A KUBE-SEP-2RAD5WKGWNVHY3DH -p tcp -m comment --comment "kube-system/kube-dns:metrics" -m tcp -j DNAT --to-destination 10.42.0.7:9153
-A KUBE-SEP-47TYL3K3JWJ36POJ -s 10.42.0.10/32 -m comment --comment "default/registry" -j KUBE-MARK-MASQ
-A KUBE-SEP-47TYL3K3JWJ36POJ -p tcp -m comment --comment "default/registry" -m tcp -j DNAT --to-destination 10.42.0.10:5000
-A KUBE-SEP-4SSQDR46DMIXOOUO -s 10.42.0.7/32 -m comment --comment "kube-system/kube-dns:dns" -j KUBE-MARK-MASQ
-A KUBE-SEP-4SSQDR46DMIXOOUO -p udp -m comment --comment "kube-system/kube-dns:dns" -m udp -j DNAT --to-destination 10.42.0.7:53
-A KUBE-SEP-B5VO6EBO7JWDMZQ2 -s 192.168.1.105/32 -m comment --comment "default/kubernetes:https" -j KUBE-MARK-MASQ
-A KUBE-SEP-B5VO6EBO7JWDMZQ2 -p tcp -m comment --comment "default/kubernetes:https" -m tcp -j DNAT --to-destination 192.168.1.105:6443
-A KUBE-SEP-EQF7TPGZGAONTLYZ -s 10.42.0.5/32 -m comment --comment "kube-system/metrics-server:https" -j KUBE-MARK-MASQ
-A KUBE-SEP-EQF7TPGZGAONTLYZ -p tcp -m comment --comment "kube-system/metrics-server:https" -m tcp -j DNAT --to-destination 10.42.0.5:10250
-A KUBE-SEP-G64LDQDZAJHDGIT6 -s 192.168.1.105/32 -m comment --comment "kube-system/traefik:web" -j KUBE-MARK-MASQ
-A KUBE-SEP-G64LDQDZAJHDGIT6 -p tcp -m comment --comment "kube-system/traefik:web" -m tcp -j DNAT --to-destination 192.168.1.105:80
-A KUBE-SEP-GP4EVLOCJ42DFVEM -s 10.42.0.11/32 -m comment --comment "default/redis" -j KUBE-MARK-MASQ
-A KUBE-SEP-GP4EVLOCJ42DFVEM -p tcp -m comment --comment "default/redis" -m tcp -j DNAT --to-destination 10.42.0.11:6379
-A KUBE-SEP-IG67G5W4T7S4OGEE -s 10.42.0.32/32 -m comment --comment "default/sumnivore" -j KUBE-MARK-MASQ
-A KUBE-SEP-IG67G5W4T7S4OGEE -p tcp -m comment --comment "default/sumnivore" -m tcp -j DNAT --to-destination 10.42.0.32:3000
-A KUBE-SEP-OG25TDWD2DXFZRMA -s 10.42.0.51/32 -m comment --comment "default/ytdl" -j KUBE-MARK-MASQ
-A KUBE-SEP-OG25TDWD2DXFZRMA -p tcp -m comment --comment "default/ytdl" -m tcp -j DNAT --to-destination 10.42.0.51:3000
-A KUBE-SEP-OZMNHHTNYIHMU5QA -s 192.168.1.105/32 -m comment --comment "default/tuby:http" -j KUBE-MARK-MASQ
-A KUBE-SEP-OZMNHHTNYIHMU5QA -p tcp -m comment --comment "default/tuby:http" -m tcp -j DNAT --to-destination 192.168.1.105:8096
-A KUBE-SEP-PQ2LHDKKDGM72FNX -s 192.168.1.105/32 -m comment --comment "default/tuby-dlna:dlna-udp" -j KUBE-MARK-MASQ
-A KUBE-SEP-PQ2LHDKKDGM72FNX -p udp -m comment --comment "default/tuby-dlna:dlna-udp" -m udp -j DNAT --to-destination 192.168.1.105:1900
-A KUBE-SEP-QEVIGMRENYKM2NRG -s 192.168.1.105/32 -m comment --comment "kube-system/traefik:websecure" -j KUBE-MARK-MASQ
-A KUBE-SEP-QEVIGMRENYKM2NRG -p tcp -m comment --comment "kube-system/traefik:websecure" -m tcp -j DNAT --to-destination 192.168.1.105:443
-A KUBE-SEP-SPW6OHKWQYLI5PJR -s 10.42.0.7/32 -m comment --comment "kube-system/kube-dns:dns-tcp" -j KUBE-MARK-MASQ
-A KUBE-SEP-SPW6OHKWQYLI5PJR -p tcp -m comment --comment "kube-system/kube-dns:dns-tcp" -m tcp -j DNAT --to-destination 10.42.0.7:53
-A KUBE-SEP-TVJD5O64HPGUK6P4 -s 10.42.0.29/32 -m comment --comment "default/sumnivore-bun" -j KUBE-MARK-MASQ
-A KUBE-SEP-TVJD5O64HPGUK6P4 -p tcp -m comment --comment "default/sumnivore-bun" -m tcp -j DNAT --to-destination 10.42.0.29:3000
-A KUBE-SERVICES -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:websecure cluster IP" -m tcp --dport 443 -j KUBE-SVC-CVG3OEGEH7H5P3HQ
-A KUBE-SERVICES -d 100.90.167.160/32 -p tcp -m comment --comment "kube-system/traefik:websecure external IP" -m tcp --dport 443 -j KUBE-EXT-CVG3OEGEH7H5P3HQ
-A KUBE-SERVICES -d 10.43.111.105/32 -p tcp -m comment --comment "default/redis cluster IP" -m tcp --dport 6379 -j KUBE-SVC-OKJCEJEOAS2LLIDR
-A KUBE-SERVICES -d 10.43.0.10/32 -p tcp -m comment --comment "kube-system/kube-dns:dns-tcp cluster IP" -m tcp --dport 53 -j KUBE-SVC-ERIFXISQEP7F7OF4
-A KUBE-SERVICES -d 10.43.63.99/32 -p tcp -m comment --comment "default/ytdl cluster IP" -m tcp --dport 80 -j KUBE-SVC-WOUR72QKFKEYR5ZG
-A KUBE-SERVICES -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:web cluster IP" -m tcp --dport 80 -j KUBE-SVC-UQMCRMJZLI3FTLDP
-A KUBE-SERVICES -d 100.90.167.160/32 -p tcp -m comment --comment "kube-system/traefik:web external IP" -m tcp --dport 80 -j KUBE-EXT-UQMCRMJZLI3FTLDP
-A KUBE-SERVICES -d 10.43.158.42/32 -p tcp -m comment --comment "default/tuby:http cluster IP" -m tcp --dport 80 -j KUBE-SVC-R462G7DIGADMZDEZ
-A KUBE-SERVICES -d 10.43.188.231/32 -p tcp -m comment --comment "default/registry cluster IP" -m tcp --dport 5000 -j KUBE-SVC-UHY5YTYXWYGJMWN5
-A KUBE-SERVICES -d 10.43.0.1/32 -p tcp -m comment --comment "default/kubernetes:https cluster IP" -m tcp --dport 443 -j KUBE-SVC-NPX46M4PTMTKRN6Y
-A KUBE-SERVICES -d 10.43.151.224/32 -p tcp -m comment --comment "kube-system/metrics-server:https cluster IP" -m tcp --dport 443 -j KUBE-SVC-Z4ANX4WAEWEBLCTM
-A KUBE-SERVICES -d 10.43.11.157/32 -p tcp -m comment --comment "default/sumnivore cluster IP" -m tcp --dport 80 -j KUBE-SVC-I7ZLXZTKXA3L3TZN
-A KUBE-SERVICES -d 10.43.112.136/32 -p tcp -m comment --comment "default/sumnivore-bun cluster IP" -m tcp --dport 80 -j KUBE-SVC-OSA2NXMW2NNWNEVJ
-A KUBE-SERVICES -d 10.43.181.51/32 -p udp -m comment --comment "default/tuby-dlna:dlna-udp cluster IP" -m udp --dport 1900 -j KUBE-SVC-5TL63OHMAKD6HCC7
-A KUBE-SERVICES -d 10.43.0.10/32 -p tcp -m comment --comment "kube-system/kube-dns:metrics cluster IP" -m tcp --dport 9153 -j KUBE-SVC-JD5MR3NA4I4DYORP
-A KUBE-SERVICES -d 10.43.0.10/32 -p udp -m comment --comment "kube-system/kube-dns:dns cluster IP" -m udp --dport 53 -j KUBE-SVC-TCOU7JCQXEZGVUNU
-A KUBE-SERVICES -m comment --comment "kubernetes service nodeports; NOTE: this must be the last rule in this chain" -m addrtype --dst-type LOCAL -j KUBE-NODEPORTS
-A KUBE-SVC-5TL63OHMAKD6HCC7 ! -s 10.42.0.0/16 -d 10.43.181.51/32 -p udp -m comment --comment "default/tuby-dlna:dlna-udp cluster IP" -m udp --dport 1900 -j KUBE-MARK-MASQ
-A KUBE-SVC-5TL63OHMAKD6HCC7 -m comment --comment "default/tuby-dlna:dlna-udp -> 192.168.1.105:1900" -j KUBE-SEP-PQ2LHDKKDGM72FNX
-A KUBE-SVC-CVG3OEGEH7H5P3HQ ! -s 10.42.0.0/16 -d 10.43.85.149/32 -p tcp -m comment --comment "kube-system/traefik:websecure cluster IP" -m tcp --dport 443 -j KUBE-MARK-MASQ
-A KUBE-SVC-CVG3OEGEH7H5P3HQ -m comment --comment "kube-system/traefik:websecure -> 192.168.1.105:443" -j KUBE-SEP-QEVIGMRENYKM2NRG
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
-A KUBE-SVC-UQMCRMJZLI3FTLDP -m comment --comment "kube-system/traefik:web -> 192.168.1.105:80" -j KUBE-SEP-G64LDQDZAJHDGIT6
-A KUBE-SVC-WOUR72QKFKEYR5ZG ! -s 10.42.0.0/16 -d 10.43.63.99/32 -p tcp -m comment --comment "default/ytdl cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-WOUR72QKFKEYR5ZG -m comment --comment "default/ytdl -> 10.42.0.51:3000" -j KUBE-SEP-OG25TDWD2DXFZRMA
-A KUBE-SVC-Z4ANX4WAEWEBLCTM ! -s 10.42.0.0/16 -d 10.43.151.224/32 -p tcp -m comment --comment "kube-system/metrics-server:https cluster IP" -m tcp --dport 443 -j KUBE-MARK-MASQ
-A KUBE-SVC-Z4ANX4WAEWEBLCTM -m comment --comment "kube-system/metrics-server:https -> 10.42.0.5:10250" -j KUBE-SEP-EQF7TPGZGAONTLYZ
COMMIT
# Completed on Sat Mar  7 09:25:55 2026

den@pi:~$ sudo ip6tables-save
# Generated by ip6tables-save v1.8.10 (nf_tables) on Sat Mar  7 09:27:10 2026
*mangle
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
:KUBE-IPTABLES-HINT - [0:0]
:KUBE-KUBELET-CANARY - [0:0]
:KUBE-PROXY-CANARY - [0:0]
COMMIT
# Completed on Sat Mar  7 09:27:10 2026
# Generated by ip6tables-save v1.8.10 (nf_tables) on Sat Mar  7 09:27:10 2026
*filter
:INPUT ACCEPT [478164:733012970]
:FORWARD ACCEPT [100387:5672732]
:OUTPUT ACCEPT [233631:18603755]
:KUBE-EXTERNAL-SERVICES - [0:0]
:KUBE-FIREWALL - [0:0]
:KUBE-FORWARD - [0:0]
:KUBE-KUBELET-CANARY - [0:0]
:KUBE-NODEPORTS - [0:0]
:KUBE-PROXY-CANARY - [0:0]
:KUBE-PROXY-FIREWALL - [0:0]
:KUBE-SERVICES - [0:0]
-A INPUT -j KUBE-FIREWALL
-A INPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
-A INPUT -m comment --comment "kubernetes health check service ports" -j KUBE-NODEPORTS
-A INPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
-A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
-A FORWARD -m comment --comment "kubernetes forwarding rules" -j KUBE-FORWARD
-A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
-A OUTPUT -j KUBE-FIREWALL
-A OUTPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
-A OUTPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A KUBE-FORWARD -m conntrack --ctstate INVALID -j DROP
-A KUBE-FORWARD -m comment --comment "kubernetes forwarding rules" -m mark --mark 0x4000/0x4000 -j ACCEPT
-A KUBE-FORWARD -m comment --comment "kubernetes forwarding conntrack rule" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
COMMIT
# Completed on Sat Mar  7 09:27:10 2026
# Generated by ip6tables-save v1.8.10 (nf_tables) on Sat Mar  7 09:27:10 2026
*nat
:PREROUTING ACCEPT [8276:1427840]
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [5557:493958]
:POSTROUTING ACCEPT [5557:493958]
:KUBE-KUBELET-CANARY - [0:0]
:KUBE-MARK-MASQ - [0:0]
:KUBE-NODEPORTS - [0:0]
:KUBE-POSTROUTING - [0:0]
:KUBE-PROXY-CANARY - [0:0]
:KUBE-SERVICES - [0:0]
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A OUTPUT -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A POSTROUTING -m comment --comment "kubernetes postrouting rules" -j KUBE-POSTROUTING
-A KUBE-MARK-MASQ -j MARK --set-xmark 0x4000/0x4000
-A KUBE-POSTROUTING -m mark ! --mark 0x4000/0x4000 -j RETURN
-A KUBE-POSTROUTING -j MARK --set-xmark 0x4000/0x0
-A KUBE-POSTROUTING -m comment --comment "kubernetes service traffic requiring SNAT" -j MASQUERADE --random-fully
-A KUBE-SERVICES ! -d ::1/128 -m comment --comment "kubernetes service nodeports; NOTE: this must be the last rule in this chain" -m addrtype --dst-type LOCAL -j KUBE-NODEPORTS
COMMIT
# Completed on Sat Mar  7 09:27:10 2026
```

### 11) sysctl values related to low-port binding and forwarding

Command:

```bash
sysctl net.ipv4.ip_unprivileged_port_start
sysctl net.ipv4.ip_forward
sysctl net.ipv4.conf.all.rp_filter
sysctl net.ipv4.conf.wt0.rp_filter
```

Paste output here:

```text
den@pi:~$ sysctl net.ipv4.ip_unprivileged_port_start
net.ipv4.ip_unprivileged_port_start = 0

den@pi:~$ sysctl net.ipv4.ip_forward
net.ipv4.ip_forward = 1

den@pi:~$ sysctl net.ipv4.conf.all.rp_filter
net.ipv4.conf.all.rp_filter = 2

den@pi:~$ sysctl net.ipv4.conf.wt0.rp_filter
net.ipv4.conf.wt0.rp_filter = 2
```

### 12) Local HTTPS test from the Pi

Command:

```bash
curl -vkI https://ytdl.mink.lan/
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```

Paste output here:

```text
den@pi:~$ curl -vkI https://ytdl.mink.lan/
* Host ytdl.mink.lan:443 was resolved.
* IPv6: (none)
* IPv4: 100.90.167.160
*   Trying 100.90.167.160:443...
* Connected to ytdl.mink.lan (100.90.167.160) port 443
* ALPN: curl offers h2,http/1.1
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
* TLSv1.3 (IN), TLS handshake, Server hello (2):
* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):
* TLSv1.3 (IN), TLS handshake, Certificate (11):
* TLSv1.3 (IN), TLS handshake, CERT verify (15):
* TLSv1.3 (IN), TLS handshake, Finished (20):
* TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):
* TLSv1.3 (OUT), TLS handshake, Finished (20):
* SSL connection using TLSv1.3 / TLS_CHACHA20_POLY1305_SHA256 / X25519 / RSASSA-PSS
* ALPN: server accepted h2
* Server certificate:
*  subject: CN=ytdl.mink.lan
*  start date: Mar  6 22:32:37 2026 GMT
*  expire date: Jun  8 22:32:37 2028 GMT
*  issuer: CN=ytdl.mink.lan
*  SSL certificate verify result: self-signed certificate (18), continuing anyway.
*   Certificate level 0: Public key type RSA (4096/152 Bits/secBits), signed using sha256WithRSAEncryption
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* using HTTP/2
* [HTTP/2] [1] OPENED stream for https://ytdl.mink.lan/
* [HTTP/2] [1] [:method: HEAD]
* [HTTP/2] [1] [:scheme: https]
* [HTTP/2] [1] [:authority: ytdl.mink.lan]
* [HTTP/2] [1] [:path: /]
* [HTTP/2] [1] [user-agent: curl/8.5.0]
* [HTTP/2] [1] [accept: */*]
> HEAD / HTTP/2
> Host: ytdl.mink.lan
> User-Agent: curl/8.5.0
> Accept: */*
>
< HTTP/2 200
HTTP/2 200
< content-type: text/html;charset=utf-8
content-type: text/html;charset=utf-8
< content-length: 401
content-length: 401
< date: Sat, 07 Mar 2026 08:28:54 GMT
date: Sat, 07 Mar 2026 08:28:54 GMT

<
* Connection #0 to host ytdl.mink.lan left intact

den@pi:~$ openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
CONNECTED(00000003)
depth=0 CN = ytdl.mink.lan
verify error:num=18:self-signed certificate
verify return:1
depth=0 CN = ytdl.mink.lan
verify return:1
---
Certificate chain
 0 s:CN = ytdl.mink.lan
   i:CN = ytdl.mink.lan
   a:PKEY: rsaEncryption, 4096 (bit); sigalg: RSA-SHA256
   v:NotBefore: Mar  6 22:32:37 2026 GMT; NotAfter: Jun  8 22:32:37 2028 GMT
---
Server certificate
-----BEGIN CERTIFICATE-----
MIIFKzCCAxOgAwIBAgIUShFQD9fkKSAdil5umKHOmmbH9OcwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNeXRkbC5taW5rLmxhbjAeFw0yNjAzMDYyMjMyMzdaFw0y
ODA2MDgyMjMyMzdaMBgxFjAUBgNVBAMMDXl0ZGwubWluay5sYW4wggIiMA0GCSqG
SIb3DQEBAQUAA4ICDwAwggIKAoICAQCjAkSwbctMFUHm9TCbcqRKnctCfj8k2H3e
rYNe1r4jruotxosnG3Z/Bo/PI+uJ7BLrwvvCxhWEZ4et4A6jwLDm17bov6kYeUtD
+SsUKGZOpzCztAabXDTZceQ+cYfY/mXF6iGBpS69oSJSkZ5m1Lee7dKVG2l5twSZ
JrnjbOEwjDt0/I98+IhDNzv1/YAE8hNZJPrgepvPDLk2nU5EsUxtFUQeWLxFpTQv
cMndlPV+6VYgdHvY9cnZN0pdt+AOvInmTpKPfWnxQ6ZbMKIUd6jznMm2NPt1R8fG
75gQOlW4J3yDjNDXsLjiKJ5nBFo64jqN1C2DWo/QiKQkpwDm15MpZ/BmEidi7h0o
d3k6ZAp2QCR7Q0qFuS1dDFX8OGWTX7XJdcJJMIZX2nAcvnwD3UZwOV/Qse8yWtKg
OtAgVDMK68SG+KrnOaEzGf8CPsj726tgtrh6OiTDULlHFN3e3pYp9LlH5QsFX1gO
kmkmtzCvXN5kWkVjzd76fHkUki8ueyms11J4ChmMBTa2tohBtJY2SFRJY96Z4ucV
vi13CcJrkEjT/ewpWi7wN4no/LbG0xZVMJU+3J8UamFd3A54qSQ+yD9e6osuj3a3
vWSXfWcA2tT4l5ZGzOKGLAdW5bgyMzIqZJ/2TkFGmbzdy1IdHUEGYOx+mb+p71e9
TqNcKkPGowIDAQABo20wazAdBgNVHQ4EFgQUmk+FuOVbZa3WU6POlMpRIZL094Mw
HwYDVR0jBBgwFoAUmk+FuOVbZa3WU6POlMpRIZL094MwDwYDVR0TAQH/BAUwAwEB
/zAYBgNVHREEETAPgg15dGRsLm1pbmsubGFuMA0GCSqGSIb3DQEBCwUAA4ICAQCa
51erVlm1fjar1mmhJVFtxOdVaZO7XW4NHUC5nObZJWpkb4OshduhZv6vMir6Pi9X
q2bVycuRaAhVD7peONGRXPrj7+R1OiOZ5OTA0RqYQu9EtzC3ZfvrsO/GgPzlXjxk
1bJs0+Y7dLuPMAlGZqfafdIPbwd7pW5rMoufbWyviFkUSPoHIM2ARto+Dq39TOLV
W4zzZWZcwbrxLb5Rag7/LX7Xmpv5/MgxG8I+fNxaFarizzScQ86ducBmNV7Ztg0I
8q8eOE7DmXglBl+azKoS61/JNT2WPWu+S6zv3MzEJA533sB2qBQ3NHwxlEBbmeUR
vDtw75NNrnkreDKu1cNV2kzAxxDyJGhUwJ9XVD+/O3abyPxcRbujJmzvBRy43Egc
oM0k2ZfMmC/yM5nySWVEYTKptV7D34ABVIG6Xm1MepiO7ueftg2eYTNRfKH5sQFC
v35pp9lfc052ByQJ40WdhEUuTqjBJ/s7zN1rDuFhQWeSNLVDgQi/21sUXqmVYaF2
w5BkoMpa2oTfWxZZLmSUZncIaG1ZawtZFhBeA5KaHz7zuo79NzC75oDgv/RokXqS
BVm4IkEUl1Wvs/De8WoOi6rBUqDo8/uPahbnsK02Vt+XslwXbznR/Or0r3Lws77L
dDy9sziqDNkm9OyWhtsojzuSMCFjwVKzAzbIMuph7Q==
-----END CERTIFICATE-----
subject=CN = ytdl.mink.lan
issuer=CN = ytdl.mink.lan
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: RSA-PSS
Server Temp Key: X25519, 253 bits
---
SSL handshake has read 2123 bytes and written 379 bytes
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_CHACHA20_POLY1305_SHA256
Server public key is 4096 bit
Secure Renegotiation IS NOT supported
Compression: NONE
Expansion: NONE
No ALPN negotiated
Early data was not sent
Verify return code: 18 (self-signed certificate)
---
---
Post-Handshake New Session Ticket arrived:
SSL-Session:
    Protocol  : TLSv1.3
    Cipher    : TLS_CHACHA20_POLY1305_SHA256
    Session-ID: 23A3179C6EC3846E7AD260C922457F193A0D5AD416BDC595147693270D943040
    Session-ID-ctx:
    Resumption PSK: 8BBF0A8A7B16871285938DDD2FA2F0C9CE760252DF89CD94A0C3D8611DD6B75B
    PSK identity: None
    PSK identity hint: None
    SRP username: None
    TLS session ticket lifetime hint: 604800 (seconds)
    TLS session ticket:
    0000 - 03 0d 44 41 66 31 6d f0-67 93 c6 49 d7 28 39 b5   ..DAf1m.g..I.(9.
    0010 - b6 c0 21 92 60 da e9 5b-07 96 c3 c8 a3 80 a1 27   ..!.`..[.......'
    0020 - 7d d4 b9 e8 d7 73 16 60-2d 72 6b f7 b3 b4 da a1   }....s.`-rk.....
    0030 - 7a fb 52 94 c5 23 c7 7d-b8 a8 d2 fd 19 9f 6f 6c   z.R..#.}......ol
    0040 - 07 e8 7b 90 5c e3 ea 68-9d 49 08 2c 29 ee 3d a1   ..{.\..h.I.,).=.
    0050 - b0 d1 18 d6 36 40 ff 0c-54 53 6e 2d 95 5b 9a 1b   ....6@..TSn-.[..
    0060 - 93 db f6 f3 00 92 a2 28-a7                        .......(.

    Start Time: 1772872149
    Timeout   : 7200 (sec)
    Verify return code: 18 (self-signed certificate)
    Extended master secret: no
    Max Early Data: 0
---
read R BLOCK
DONE
```

### 13) Peer-to-Pi test from another NetBird peer

Please run this from a different NetBird-connected machine, not the Pi itself.

Command:

```bash
getent hosts ytdl.mink.lan
curl -vkI https://ytdl.mink.lan/
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```

Paste output here:

```text
~ ❯ getent hosts ytdl.mink.lan                                                                   09:31:57

100.90.167.160  ytdl.mink.lan

~ ❯ curl -vkI https://ytdl.mink.lan/                                                             09:32:03

* Host ytdl.mink.lan:443 was resolved.
* IPv6: (none)
* IPv4: 100.90.167.160
*   Trying 100.90.167.160:443...
* ALPN: curl offers h2,http/1.1
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
* TLSv1.3 (IN), TLS handshake, Server hello (2):
* TLSv1.3 (IN), TLS change cipher, Change cipher spec (1):
* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):
* TLSv1.3 (IN), TLS handshake, Certificate (11):
* TLSv1.3 (IN), TLS handshake, CERT verify (15):
* TLSv1.3 (IN), TLS handshake, Finished (20):
* TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):
* TLSv1.3 (OUT), TLS handshake, Finished (20):
* SSL connection using TLSv1.3 / TLS_CHACHA20_POLY1305_SHA256 / x25519 / RSASSA-PSS
* ALPN: server accepted h2
* Server certificate:
*  subject: CN=ytdl.mink.lan
*  start date: Mar  6 22:32:37 2026 GMT
*  expire date: Jun  8 22:32:37 2028 GMT
*  issuer: CN=ytdl.mink.lan
*  SSL certificate verify result: self-signed certificate (18), continuing anyway.
*   Certificate level 0: Public key type RSA (4096/152 Bits/secBits), signed using sha256WithRSAEncryption
* Connected to ytdl.mink.lan (100.90.167.160) port 443
* using HTTP/2
* [HTTP/2] [1] OPENED stream for https://ytdl.mink.lan/
* [HTTP/2] [1] [:method: HEAD]
* [HTTP/2] [1] [:scheme: https]
* [HTTP/2] [1] [:authority: ytdl.mink.lan]
* [HTTP/2] [1] [:path: /]
* [HTTP/2] [1] [user-agent: curl/8.14.1]
* [HTTP/2] [1] [accept: */*]
> HEAD / HTTP/2
> Host: ytdl.mink.lan
> User-Agent: curl/8.14.1
> Accept: */*
>
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* Request completely sent off
< HTTP/2 200
HTTP/2 200
< content-type: text/html;charset=utf-8
content-type: text/html;charset=utf-8
< content-length: 401
content-length: 401
< date: Sat, 07 Mar 2026 08:32:12 GMT
date: Sat, 07 Mar 2026 08:32:12 GMT
<

* Connection #0 to host ytdl.mink.lan left intact

~ ❯ openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null             09:32:12

Connecting to 100.90.167.160
CONNECTED(00000003)
depth=0 CN=ytdl.mink.lan
verify error:num=18:self-signed certificate
verify return:1
depth=0 CN=ytdl.mink.lan
verify return:1
---
Certificate chain
 0 s:CN=ytdl.mink.lan
   i:CN=ytdl.mink.lan
   a:PKEY: RSA, 4096 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Mar  6 22:32:37 2026 GMT; NotAfter: Jun  8 22:32:37 2028 GMT
---
Server certificate
-----BEGIN CERTIFICATE-----
MIIFKzCCAxOgAwIBAgIUShFQD9fkKSAdil5umKHOmmbH9OcwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNeXRkbC5taW5rLmxhbjAeFw0yNjAzMDYyMjMyMzdaFw0y
ODA2MDgyMjMyMzdaMBgxFjAUBgNVBAMMDXl0ZGwubWluay5sYW4wggIiMA0GCSqG
SIb3DQEBAQUAA4ICDwAwggIKAoICAQCjAkSwbctMFUHm9TCbcqRKnctCfj8k2H3e
rYNe1r4jruotxosnG3Z/Bo/PI+uJ7BLrwvvCxhWEZ4et4A6jwLDm17bov6kYeUtD
+SsUKGZOpzCztAabXDTZceQ+cYfY/mXF6iGBpS69oSJSkZ5m1Lee7dKVG2l5twSZ
JrnjbOEwjDt0/I98+IhDNzv1/YAE8hNZJPrgepvPDLk2nU5EsUxtFUQeWLxFpTQv
cMndlPV+6VYgdHvY9cnZN0pdt+AOvInmTpKPfWnxQ6ZbMKIUd6jznMm2NPt1R8fG
75gQOlW4J3yDjNDXsLjiKJ5nBFo64jqN1C2DWo/QiKQkpwDm15MpZ/BmEidi7h0o
d3k6ZAp2QCR7Q0qFuS1dDFX8OGWTX7XJdcJJMIZX2nAcvnwD3UZwOV/Qse8yWtKg
OtAgVDMK68SG+KrnOaEzGf8CPsj726tgtrh6OiTDULlHFN3e3pYp9LlH5QsFX1gO
kmkmtzCvXN5kWkVjzd76fHkUki8ueyms11J4ChmMBTa2tohBtJY2SFRJY96Z4ucV
vi13CcJrkEjT/ewpWi7wN4no/LbG0xZVMJU+3J8UamFd3A54qSQ+yD9e6osuj3a3
vWSXfWcA2tT4l5ZGzOKGLAdW5bgyMzIqZJ/2TkFGmbzdy1IdHUEGYOx+mb+p71e9
TqNcKkPGowIDAQABo20wazAdBgNVHQ4EFgQUmk+FuOVbZa3WU6POlMpRIZL094Mw
HwYDVR0jBBgwFoAUmk+FuOVbZa3WU6POlMpRIZL094MwDwYDVR0TAQH/BAUwAwEB
/zAYBgNVHREEETAPgg15dGRsLm1pbmsubGFuMA0GCSqGSIb3DQEBCwUAA4ICAQCa
51erVlm1fjar1mmhJVFtxOdVaZO7XW4NHUC5nObZJWpkb4OshduhZv6vMir6Pi9X
q2bVycuRaAhVD7peONGRXPrj7+R1OiOZ5OTA0RqYQu9EtzC3ZfvrsO/GgPzlXjxk
1bJs0+Y7dLuPMAlGZqfafdIPbwd7pW5rMoufbWyviFkUSPoHIM2ARto+Dq39TOLV
W4zzZWZcwbrxLb5Rag7/LX7Xmpv5/MgxG8I+fNxaFarizzScQ86ducBmNV7Ztg0I
8q8eOE7DmXglBl+azKoS61/JNT2WPWu+S6zv3MzEJA533sB2qBQ3NHwxlEBbmeUR
vDtw75NNrnkreDKu1cNV2kzAxxDyJGhUwJ9XVD+/O3abyPxcRbujJmzvBRy43Egc
oM0k2ZfMmC/yM5nySWVEYTKptV7D34ABVIG6Xm1MepiO7ueftg2eYTNRfKH5sQFC
v35pp9lfc052ByQJ40WdhEUuTqjBJ/s7zN1rDuFhQWeSNLVDgQi/21sUXqmVYaF2
w5BkoMpa2oTfWxZZLmSUZncIaG1ZawtZFhBeA5KaHz7zuo79NzC75oDgv/RokXqS
BVm4IkEUl1Wvs/De8WoOi6rBUqDo8/uPahbnsK02Vt+XslwXbznR/Or0r3Lws77L
dDy9sziqDNkm9OyWhtsojzuSMCFjwVKzAzbIMuph7Q==
-----END CERTIFICATE-----
subject=CN=ytdl.mink.lan
issuer=CN=ytdl.mink.lan
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: rsa_pss_rsae_sha256
Peer Temp Key: X25519, 253 bits
---
SSL handshake has read 2123 bytes and written 1608 bytes
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_CHACHA20_POLY1305_SHA256
Protocol: TLSv1.3
Server public key is 4096 bit
This TLS version forbids renegotiation.
Compression: NONE
Expansion: NONE
No ALPN negotiated
Early data was not sent
Verify return code: 18 (self-signed certificate)
---
---
Post-Handshake New Session Ticket arrived:
SSL-Session:
    Protocol  : TLSv1.3
    Cipher    : TLS_CHACHA20_POLY1305_SHA256
    Session-ID: 34EB4B5E5388C1D1D3097C89BC3A8211721224CAC187F27B4AC29818A0DAD5FA
    Session-ID-ctx:
    Resumption PSK: 64EC3A74167D921E6AA438BFDE693BDA4132A20AC51BDDD6F904766C03F412D5
    PSK identity: None
    PSK identity hint: None
    SRP username: None
    TLS session ticket lifetime hint: 604800 (seconds)
    TLS session ticket:
    0000 - 0b f8 3a 25 7a 22 ec 7d-35 9e 17 a1 ef 10 9b 70   ..:%z".}5......p
    0010 - d7 67 87 4c b3 18 34 48-c2 b5 e9 e0 74 98 3c 36   .g.L..4H....t.<6
    0020 - e7 fb 1d 08 33 7d ae 11-c0 93 a6 c4 1e 3d f7 a1   ....3}.......=..
    0030 - ef f4 9d ef 84 74 77 80-46 72 79 d9 f4 ef 1d 3f   .....tw.Fry....?
    0040 - bd 59 7b f2 0f 53 68 fa-48 53 50 4e 86 dc 59 a4   .Y{..Sh.HSPN..Y.
    0050 - b5 54 fc ef 3f 0e 9a a5-40 b9 d3 0c a0 28 2c 36   .T..?...@....(,6
    0060 - c1 43 be c6 01 fc 91 dc-e8                        .C.......

    Start Time: 1772872342
    Timeout   : 7200 (sec)
    Verify return code: 18 (self-signed certificate)
    Extended master secret: no
    Max Early Data: 0
---
read R BLOCK
DONE
```

## What I will assess once you paste the outputs

After you paste the command outputs, I can determine:

- whether Traefik is currently exposed by `LoadBalancer`, `NodePort`, hostNetwork, or hostPort
- whether `svclb-traefik-*` still exists anywhere
- whether `wt0` traffic is hitting the host and being NATed correctly
- whether the hostname resolves to the expected NetBird IP
- whether the TLS secret and ingress are wired correctly
- whether the redirect-based design is viable exactly as-is on your Pi
- the exact nftables or iptables rules to make persistent
- the exact Traefik `HelmChartConfig` needed for a clean NodePort + redirect setup

## Current recommendation

My current best guess is:

- the cleanest long-term fix is **NodePort Traefik + host redirect on `wt0` only**
- not **host-bound Traefik on 80/443**
- and not **fully default K3s LoadBalancer Traefik with `svclb`**, unless the live inspection proves `svclb` can be made to handle `wt0` traffic correctly without further hacks

That approach keeps the NetBird exposure narrow and explicit, avoids low-port binding tricks, and makes the data path easier to reason about.

## Assessment after reviewing the Pi outputs

### What is true right now

- The current setup works end-to-end for NetBird peers.
- `ytdl.mink.lan` resolves to the Pi's NetBird IP `100.90.167.160`.
- Peer-to-Pi HTTPS succeeds and reaches the correct ingress/app.
- The current Traefik deployment is **not** packaged-default anymore:
  - `hostNetwork: true`
  - `service.type: ClusterIP`
  - Traefik process is listening directly on host `*:80` and `*:443`
  - container has `NET_BIND_SERVICE`
- `svclb-traefik-*` is gone.
- K3s kube-proxy is also handling the Traefik service's `externalIPs` for `100.90.167.160`; the NAT counters prove packets to the NetBird IP are traversing kube-proxy rules.

### My judgement

- Your current workaround is valid, but it is more invasive than necessary.
- The main thing making it "special" is not NetBird itself; it is that Traefik is running on the host network and binding low ports directly.
- The evidence says the Pi can already accept `wt0` traffic cleanly, and kube-proxy can already match traffic destined to the NetBird IP.
- Because of that, the alternative **NodePort + `wt0`-only redirect** design is viable on this host.
- You should also be able to remove `net.ipv4.ip_unprivileged_port_start=0` once Traefik is no longer binding low ports directly.

### One extra observation

There is also evidence for a possible simpler fallback design than redirects:

- keep Traefik off hostNetwork
- keep or set `externalIPs: [100.90.167.160]` on the Traefik service
- let kube-proxy DNAT directly from the NetBird IP to Traefik's pod/service backend

I am not making that the primary recommendation because you explicitly asked for the redirect design, but the current kube-proxy counters show that `externalIPs` on the NetBird IP are already active and functioning.

## Recommended next steps

### Recommended target

Move to:

- packaged-style Traefik networking again
- no `hostNetwork`
- no direct host bind on `80/443`
- no low-port sysctl dependency
- fixed Traefik `NodePort`s
- host NAT redirect on `wt0` only

### Use these NodePorts

Do **not** use `30080`, because `tuby` already uses it.

Suggested Traefik NodePorts:

- HTTP: `32080`
- HTTPS: `32443`

### Traefik config shape to move toward

Replace the current `traefik-config.yaml` with something conceptually like this:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    deployment:
      replicas: 1
    service:
      type: NodePort
      externalIPs:
        - 100.90.167.160
    ports:
      web:
        port: 8000
        exposedPort: 80
        nodePort: 32080
      websecure:
        port: 8443
        exposedPort: 443
        nodePort: 32443
```

Notes:

- The important removals are `hostNetwork`, `dnsPolicy: ClusterFirstWithHostNet`, and the low-port bind/security overrides.
- `port: 8000` and `port: 8443` are the normal non-privileged Traefik container ports.
- I left `externalIPs` in place as a conservative compatibility measure because your current kube-proxy rules already use it successfully for the NetBird IP.

### Redirect rules to add on the Pi

Use `nftables`, since the host is already running nft-backed rules.

Conceptual rules:

```bash
sudo nft add table inet traefik_wt0_redirect
sudo nft 'add chain inet traefik_wt0_redirect prerouting { type nat hook prerouting priority dstnat; policy accept; }'
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 80 redirect to :32080
sudo nft add rule inet traefik_wt0_redirect prerouting iifname "wt0" tcp dport 443 redirect to :32443
```

This keeps the redirect scope tight:

- only packets entering on `wt0`
- only TCP `80/443`
- no effect on LAN traffic on `eth0`

### Migration order

Safest order:

1. Change Traefik to `NodePort` with fixed NodePorts and remove `hostNetwork`.
2. Wait for Traefik rollout and verify `kubectl -n kube-system get svc traefik` shows the new NodePorts.
3. Before changing DNS or other access assumptions, add the `wt0` redirect rules.
4. Test from another NetBird peer.
5. If it works, remove the now-unneeded low-port sysctl override.

### Validation commands after the change

Run these after applying the new Traefik config and redirect rules:

```bash
kubectl -n kube-system get svc traefik -o wide
kubectl -n kube-system get pods -o wide
sudo ss -ltnp | grep -E ':80|:443|:32080|:32443'
sudo nft list ruleset | sed -n '/traefik_wt0_redirect/,+20p'
curl -vkI https://ytdl.mink.lan/
```

From another NetBird peer:

```bash
curl -vkI https://ytdl.mink.lan/
openssl s_client -connect ytdl.mink.lan:443 -servername ytdl.mink.lan </dev/null
```

## A few caveats

### DNS on the Pi itself

- `getent hosts ytdl.mink.lan` works.
- `resolvectl query ytdl.mink.lan` does not.

That means host-side name resolution is a bit inconsistent, but application-level resolution is currently fine. I would treat this as a separate DNS hygiene issue, not a blocker for the Traefik migration.

### App manifest drift

- The live cluster clearly has repo drift already (`ytdl-config` PVC exists live, but not in the repo manifests you showed).
- The app still appears not to mount the shared download PVC in `k8s/app.yml`.

That is separate from ingress networking, but worth fixing once the network path is settled.

## Bottom line

- The current setup is working.
- The redirect-based alternative is viable on this Pi.
- I recommend migrating away from `hostNetwork` Traefik and low-port host binding.
- Use fixed NodePorts `32080` and `32443`, then redirect only `wt0` traffic to those ports.
- After that, revert `net.ipv4.ip_unprivileged_port_start` unless something else on the box still depends on it.
