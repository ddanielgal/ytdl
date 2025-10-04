# YouTube Downloader - BullMQ + SQLite Setup

This guide will help you set up the enhanced YouTube downloader with persistent progress tracking using BullMQ and SQLite.

## What's New

✅ **Persistent Progress**: Progress is saved to SQLite database - survives app restarts  
✅ **Job Queue**: BullMQ manages download jobs with Redis  
✅ **Real-time Updates**: tRPC subscriptions for live progress  
✅ **Error Handling**: Robust retry logic and error tracking  
✅ **k3s Ready**: Complete Kubernetes deployment manifests  

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Next.js App   │    │   BullMQ Queue  │    │   SQLite DB     │
│                 │    │                 │    │                 │
│ • VideoAdderForm│◄──►│ • Job Management│◄──►│ • Job Status    │
│ • ProgressList  │    │ • Worker Queue  │    │ • Progress      │
│ • VideoProgress │    │ • Retry Logic   │    │ • Persistence   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │
         │                       │
         ▼                       ▼
┌─────────────────┐    ┌─────────────────┐
│   tRPC API      │    │   Redis Cache   │
│                 │    │                 │
│ • addVideo      │    │ • Job Queue     │
│ • getActiveJobs │    │ • Progress      │
│ • jobProgress   │    │ • Worker State  │
└─────────────────┘    └─────────────────┘
```

## Local Development Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set up Database

```bash
# Generate Prisma client
npx prisma generate

# Create and migrate database
npx prisma db push
```

### 3. Start Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis:7-alpine

# Or using local Redis
redis-server
```

### 4. Start the Application

```bash
npm run dev
```

## k3s Deployment

### 1. Build Docker Image

```bash
# Build the image
docker build -t ytdl:latest .

# Tag for your registry (if using one)
docker tag ytdl:latest your-registry/ytdl:latest
docker push your-registry/ytdl:latest
```

### 2. Deploy to k3s

```bash
# Deploy Redis
kubectl apply -f k8s/redis-deployment.yaml

# Deploy the application
kubectl apply -f k8s/app-deployment.yaml

# Set up ingress (optional)
kubectl apply -f k8s/ingress.yaml
```

### 3. Initialize Database

```bash
# Get the pod name
kubectl get pods

# Run database migration
kubectl exec -it <pod-name> -- npx prisma db push
```

## Key Features

### Persistent Progress
- Progress is automatically saved to SQLite database
- App restart preserves all active downloads
- Real-time updates via tRPC subscriptions

### Job Queue Management
- BullMQ handles job queuing and processing
- Automatic retry on failures (3 attempts)
- Concurrent download limit (2 jobs)
- Job status tracking (PENDING → ACTIVE → COMPLETED/FAILED)

### Enhanced UI
- Status badges (PENDING, ACTIVE, COMPLETED, FAILED)
- Error messages for failed downloads
- Progress persistence across sessions
- Real-time progress updates

## API Changes

### New tRPC Endpoints

```typescript
// Get all active jobs (for persistence)
trpc.getActiveJobs.useQuery()

// Get specific job progress
trpc.getJobProgress.useQuery({ jobId: "..." })

// Real-time progress subscription
trpc.jobProgress.useSubscription({ jobId: "..." })

// Job completion subscription
trpc.jobFinished.useSubscription({ jobId: "..." })
```

### Updated Data Model

```typescript
type Video = {
  id: string;           // Job ID (was URL-based)
  url: string;
  title: string;
  progress: number;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "FAILED" | "DELAYED" | "WAITING";
  error?: string;
}
```

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL="file:./dev.db"

# Redis
REDIS_URL="redis://localhost:6379"

# yt-dlp
YTDLP_PATH="/usr/local/bin/yt-dlp"
```

### k3s Resources

- **App**: 256Mi-512Mi memory, 100m-500m CPU
- **Redis**: 64Mi-128Mi memory, 50m-100m CPU
- **Storage**: 10Gi for app data, 1Gi for Redis

## Monitoring

### Check Application Status

```bash
# Pod status
kubectl get pods

# Application logs
kubectl logs -f deployment/ytdl-app

# Redis logs
kubectl logs -f deployment/redis
```

### Database Management

```bash
# Open Prisma Studio
kubectl exec -it <pod-name> -- npx prisma studio

# Check database
kubectl exec -it <pod-name> -- sqlite3 /app/data/dev.db
```

## Troubleshooting

### Common Issues

1. **Redis Connection Failed**
   - Check if Redis service is running
   - Verify REDIS_URL environment variable

2. **Database Errors**
   - Ensure data volume is mounted correctly
   - Run `npx prisma db push` to sync schema

3. **yt-dlp Not Found**
   - Verify YTDLP_PATH is correct
   - Check if yt-dlp binary is installed in container

### Useful Commands

```bash
# Check service endpoints
kubectl get endpoints

# Execute commands in pod
kubectl exec -it <pod-name> -- /bin/sh

# Port forward for local access
kubectl port-forward service/ytdl-app 3000:80
```

## Next Steps

1. **Set up Redis** on your k3s cluster
2. **Deploy the application** using the provided manifests
3. **Test persistent progress** by adding a video and restarting the app
4. **Monitor job queue** using Redis CLI or BullMQ dashboard

The application now provides a robust, persistent download experience with real-time progress tracking and efficient job management!
