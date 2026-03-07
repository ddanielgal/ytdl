# Networking Notes: getting `ytdl.mink.lan` reachable over NetBird

This document explains the networking shape we want for this repo, what went wrong on the way there, and what we learned.

It is written for people who are comfortable with Linux and Kubernetes basics, but are not deep networking specialists.

## The setup in one paragraph

The app runs in `k3s` on a Raspberry Pi. Inside the cluster, Traefik handles the ingress for `ytdl.mink.lan` and forwards requests to the `ytdl` service, which sends traffic to the app pod. Outside the cluster, the Raspberry Pi is also a NetBird peer. The goal is for other NetBird peers to open `https://ytdl.mink.lan/` and reach the app over the NetBird overlay network, without making Traefik do unusual host-level things.

## Desired end state

The desired steady state is:

- `ytdl.mink.lan` resolves, for NetBird peers, to the Raspberry Pi's NetBird IP.
- Traefik stays a normal `k3s` pod.
- The Traefik service stays `ClusterIP`.
- The Kubernetes routing model stays mostly normal: `Ingress -> Service -> Pod`.
- The only custom networking lives on the Pi host, at the NetBird edge.

That is the important design choice: keep Kubernetes boring, and keep the NetBird-specific behavior at the machine that actually participates in NetBird.

## What the app topology looks like

From the repo:

- `k8s/app.yml` defines `Deployment/ytdl`, `Service/ytdl`, and `Ingress/ytdl`.
- The app listens on port `3000`.
- The service exposes `80 -> 3000`.
- The ingress host is `ytdl.mink.lan` and uses Traefik.

So the in-cluster path is straightforward:

`client -> Traefik ingress -> Service/ytdl -> app pod`

The tricky part is not the app. The tricky part is getting traffic from a remote NetBird peer onto the Pi, through host networking rules, and into the Traefik pod in a way that still allows return traffic.

## The mental model that finally made this make sense

There are really three networks involved:

1. The NetBird overlay network, where peers talk to each other over `wt0`.
2. The Linux host network on the Raspberry Pi, where nftables and forwarding decisions happen.
3. The Kubernetes pod network, where Traefik and the app actually live.

The request has to cross all three.

That is why this problem felt weird: DNS looked right, the app looked right, Traefik looked right, but the end-to-end packet path still failed.

## What we wanted to be true

The simple hope was:

- NetBird peer resolves `ytdl.mink.lan`
- traffic lands on the Pi
- Kubernetes or Traefik naturally picks it up
- app responds

In practice, that was too optimistic. The host had to explicitly help the packet cross from the NetBird interface into the pod network.

## What was confirmed early

These parts were not the problem:

- NetBird DNS was resolving `ytdl.mink.lan` to the Pi's NetBird IP.
- peer traffic was reaching the Pi on `wt0`.
- Traefik routing was healthy once traffic reached Traefik.
- direct access from the Pi to the Traefik pod worked when using the right host header.

That narrowed the issue to the host forwarding/NAT path between `wt0` and the pod network.

## What we tried that did not hold up

### `externalIPs`

One attempt was to put the Pi's NetBird IP on the Traefik service using `externalIPs`.

Why it seemed reasonable:

- Kubernetes documents `externalIPs` as a way to make a service reachable on specific IPs.
- the NetBird IP looked like just another host IP.

Why it did not solve the real problem here:

- the packet still had to traverse host forwarding and filtering correctly.
- for real peer traffic, that path was still not complete.

So `externalIPs` was not enough.

### `NodePort` plus redirect

Another attempt was:

- expose Traefik as `NodePort`
- redirect `wt0:80/443` to the NodePort values on the host

Again, this sounded plausible because NodePort is designed to expose a service via the node.

But real peer traffic still did not make it cleanly through the full path. It added another moving part without removing the underlying forwarding problem.

### Changing Traefik itself

There were also experiments around making Traefik more host-like, such as `hostNetwork` and low-port binding workarounds.

Those turned out to be the wrong direction.

The blocker was not that Traefik could not listen in the right place. The blocker was that forwarded NetBird traffic still needed explicit host-side handling.

That was a useful lesson: when packets are dying before a pod sees them, changing the pod is often not the real fix.

## What the actual problem was

The working diagnosis was:

- traffic arrived from another NetBird peer on `wt0`
- the Pi needed to forward that traffic toward a pod IP
- NetBird's own nftables forward chain did not automatically allow that forwarded flow
- reply traffic also needed source NAT so the return path stayed valid

In plain language: the packet could arrive, but the host still needed help to forward it and help to make the response come back the right way.

Two host-side behaviors were missing:

- destination NAT to send traffic from the Pi's NetBird IP and port `80/443` to the Traefik pod on `8000/8443`
- masquerading on the way into the pod network so responses returned through the Pi correctly

And one explicit allow was needed in NetBird's nftables-managed forwarding path.

## The working packet path

Once fixed, the path became:

`NetBird peer -> Pi wt0:80/443 -> host DNAT -> Traefik pod:8000/8443 -> host MASQUERADE on cni0 -> Traefik ingress -> Service/ytdl -> app pod`

That is the core finding from the whole exercise.

## Why DNAT was needed

Traefik is not running on the host network. It is running as a pod.

So when traffic hits the Pi's NetBird IP, the host has to decide what to do with it. The host cannot assume that a packet for `100.x.x.x:443` should magically jump into a pod listening on `10.42.x.x:8443`.

DNAT gives the host an explicit answer:

- if traffic comes in on `wt0`
- and it is for the Pi's NetBird IP on `80` or `443`
- rewrite the destination to the current Traefik pod IP on `8000` or `8443`

That gets the packet to the right place.

## Why MASQUERADE was needed

This was the least intuitive part.

Even after traffic was pointed at the Traefik pod, reply packets still had to find their way back to the original NetBird peer. The pod network and the NetBird overlay are different routing domains. Without help, the response path was not reliable.

MASQUERADE is a special form of source NAT. In this setup, it makes the forwarded traffic look like it came from the Pi's side of the pod network, so the reply naturally returns to the Pi, which can then send it back to the NetBird peer.

This matches the general networking rule that if you cannot rely on the remote side having a proper return route, source NAT often simplifies the path.

NetBird's own docs make the same general point for routed traffic: masquerading is often the pragmatic choice because it avoids needing extra return-route configuration.

## Why a NetBird forward allow rule was needed

Another key lesson: NetBird is not just a tunnel interface. It also manages nftables rules on the host.

That means packets forwarded from `wt0` toward the pod network can still be filtered by NetBird-managed chains.

In this case, the critical chain was `table ip netbird`, chain `netbird-rt-fwd`. Until the flow to the Traefik pod ports was explicitly accepted there, real peer traffic still failed.

This explains why some tests looked misleadingly healthy:

- local traffic from the Pi to the pod worked
- but real forwarded traffic from another peer did not

Those are not the same path.

## Why the chosen design is the least-bad one

The chosen design keeps the special handling very narrow:

- only traffic arriving on `wt0` is customized
- only ports `80` and `443` are customized
- only the Traefik pod ports are opened in the NetBird forward chain
- LAN traffic on normal interfaces stays alone
- Kubernetes objects stay close to their default intent

That is better than bending Traefik into host mode or piling on extra Kubernetes exposure tricks that still depend on host behavior anyway.

## The main operational wrinkle

The working fix targeted the Traefik pod IP directly.

That is fine for proving the path, but pod IPs are not durable. Traefik can restart and come back with a different `10.42.x.x` address.

There is also a second persistence issue: NetBird owns its own nftables table, so manually inserted allow rules in that table should not be treated as permanent.

That leads to the practical answer: use a small reconciliation script on the Pi.

Its job is to:

- discover the current Traefik pod IP
- rebuild the custom DNAT and MASQUERADE rules with that IP
- re-add the needed NetBird forward accepts for that same IP

In other words, the durable solution is not a static config file. It is a tiny bit of discovery plus rule re-application.

## What the end state should look like in practice

In day-to-day terms, the healthy setup is:

- NetBird DNS maps `ytdl.mink.lan` to the Pi's NetBird IP
- Traefik runs as a normal pod in `k3s`
- Traefik service type is `ClusterIP`
- the Pi host has a dedicated nftables rule set for `wt0` ingress
- a Pi-local reconcile step keeps those rules aligned with the current Traefik pod IP and NetBird state

That is the desired state for this repo.

## Things we learned

### 1. DNS success does not mean routing success

It is easy to stop debugging once the name resolves correctly. But DNS only proves that clients know which IP to use. It says nothing about whether the host will forward the traffic into the right network.

### 2. Local success does not mean peer success

`curl` from the Pi to a pod is not the same as traffic forwarded from another NetBird peer. If the real use case is forwarded overlay traffic, that exact path has to be tested.

### 3. Kubernetes exposure primitives do not replace host networking reality

`externalIPs` and `NodePort` are useful tools, but they do not magically erase host firewall, routing, NAT, or overlay-network constraints.

### 4. If the app works once traffic reaches the ingress, stop changing the app

Once Traefik and the app proved healthy, the remaining work belonged at the host edge. Changing pod security settings and host bindings only added noise.

### 5. NAT is often about the return path, not just the forward path

The breakthrough was not only getting packets into the pod network. It was making the response path predictable.

### 6. Overlay products often manage firewall state too

NetBird does more than provide an interface and routes. It also manages rules that can affect forwarded traffic. That matters a lot when debugging.

## A note on TLS behavior

There was one result that looked odd until it was expected:

- `https://ytdl.mink.lan/` returned the correct certificate
- `https://<Pi-NetBird-IP>/` with `Host: ytdl.mink.lan` still returned the Traefik default certificate

That difference is normal. TLS certificate selection depends on SNI, which is based on the hostname the client connects to. Connecting by IP but overriding only the HTTP `Host` header is too late for TLS certificate choice.

## A note on scope

This document is only about ingress/network reachability for the app.

There is a separate app-level issue noted during research: the app reads from local `data/`, but the app deployment does not currently mount the same PVC the worker uses. That matters for functionality, but it is independent of the NetBird ingress problem.

## Recommended direction

If we want a clean, supportable setup, the direction should stay:

- keep Traefik normal
- keep the service `ClusterIP`
- keep NetBird-specific logic on the Pi host
- reconcile the few custom nftables rules instead of hard-coding them once

That gives us the smallest custom surface area while still making `ytdl.mink.lan` reachable from other NetBird peers.

## Useful references

- NetBird DNS docs: <https://docs.netbird.io/manage/dns>
- NetBird network routes docs: <https://docs.netbird.io/manage/network-routes>
- Kubernetes Service docs: <https://kubernetes.io/docs/concepts/services-networking/service/>
- Kubernetes Ingress docs: <https://kubernetes.io/docs/concepts/services-networking/ingress/>
- nftables NAT docs: <https://wiki.nftables.org/wiki-nftables/index.php/Performing_Network_Address_Translation_(NAT)>
