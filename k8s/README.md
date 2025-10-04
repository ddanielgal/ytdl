# YouTube Downloader - k3s Deployment

This directory contains Kubernetes manifests for deploying the YouTube downloader application on a k3s cluster.

## Prerequisites

- k3s cluster running on Raspberry Pi
- `kubectl` configured to access your cluster
- Docker image built and available in your cluster

## Deployment Steps

### 1. Build and Push Docker Image

```bash
# Build the Docker image
docker build -t ytdl:latest .

# Tag for your registry (if using one)
docker tag ytdl:latest your-registry/ytdl:latest
docker push your-registry/ytdl:latest
```

### 2. Deploy Redis

```bash
kubectl apply -f redis-deployment.yaml
```

### 3. Deploy the Application

```bash
kubectl apply -f app-deployment.yaml
```

### 4. Set up Ingress (Optional)

```bash
kubectl apply -f ingress.yaml
```

### 5. Initialize Database

```bash
# Get the pod name
kubectl get pods

# Run database migration
kubectl exec -it <pod-name> -- npx prisma db push
```

## Configuration

### Environment Variables

- `DATABASE_URL`: SQLite database file path (default: `file:/app/data/dev.db`)
- `REDIS_URL`: Redis connection string (default: `redis://redis:6379`)
- `YTDLP_PATH`: Path to yt-dlp binary (default: `/usr/local/bin/yt-dlp`)

### Storage

- **App Data**: 10Gi persistent volume for SQLite database and downloaded videos
- **Redis Data**: 1Gi persistent volume for Redis data

### Resources

- **App Container**: 256Mi-512Mi memory, 100m-500m CPU
- **Redis Container**: 64Mi-128Mi memory, 50m-100m CPU

## Access

- **Local**: `http://ytdl.local` (if ingress is configured)
- **Port Forward**: `kubectl port-forward service/ytdl-app 3000:80`

## Monitoring

```bash
# Check pod status
kubectl get pods

# Check logs
kubectl logs -f deployment/ytdl-app

# Check Redis logs
kubectl logs -f deployment/redis
```

## Troubleshooting

### Common Issues

1. **yt-dlp not found**: Ensure the yt-dlp binary is properly installed in the container
2. **Redis connection failed**: Check if Redis service is running and accessible
3. **Database errors**: Ensure the data volume is mounted correctly

### Useful Commands

```bash
# Check service endpoints
kubectl get endpoints

# Describe pod for debugging
kubectl describe pod <pod-name>

# Execute commands in pod
kubectl exec -it <pod-name> -- /bin/sh
```
