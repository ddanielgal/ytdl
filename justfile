list:
    just -l

build:
    podman build --network host --jobs 4 -t pi.home:30500/ddanielgal/ytdl --platform linux/arm64/v8 .

push:
    podman push pi.home:30500/ddanielgal/ytdl

upgrade:
    kubectl rollout restart deployment/ytdl
    kubectl rollout restart deployment/ytdl-worker

# Run the full dev environment (app + redis + worker)
dev:
    npx concurrently --kill-others --names app,redis,worker --prefix-colors blue,red,green \
        "npm run dev" \
        "podman run --rm --replace --name ytdl-redis -p 6379:6379 redis:7-alpine" \
        "npm run worker:dev"

dev-redis:
    podman run --rm --replace --name ytdl-redis -p 6379:6379 redis:7-alpine

dev-worker:
    npm run worker:dev

dev-app:
    npm run dev
