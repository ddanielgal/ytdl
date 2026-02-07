list:
    just -l

build:
    podman build --network host --jobs 4 -t pi.home:30500/ddanielgal/ytdl --platform linux/arm64/v8 .

push:
    podman push pi.home:30500/ddanielgal/ytdl

upgrade:
    kubectl rollout restart deployment/ytdl
    kubectl rollout restart deployment/ytdl-worker
