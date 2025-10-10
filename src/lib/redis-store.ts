import { Redis } from "ioredis";
import env from "~/env";

// Redis connection
const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
});

export interface JobData {
    id: string;
    url: string;
    title: string;
    progress: number;
    status: "PENDING" | "ACTIVE" | "COMPLETED" | "FAILED" | "DELAYED" | "WAITING";
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    steps: {
        info: { status: "pending" | "active" | "completed" | "failed"; progress: number };
        download: { status: "pending" | "active" | "completed" | "failed"; progress: number };
        remux: { status: "pending" | "active" | "completed" | "failed"; progress: number };
        subtitles: { status: "pending" | "active" | "completed" | "failed"; progress: number };
    };
}

export class RedisStore {
    private static instance: RedisStore;
    private redis: Redis;

    constructor() {
        this.redis = redis;
    }

    static getInstance(): RedisStore {
        if (!RedisStore.instance) {
            RedisStore.instance = new RedisStore();
        }
        return RedisStore.instance;
    }

    async createJob(url: string): Promise<string> {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date().toISOString();

        const jobData: JobData = {
            id: jobId,
            url,
            title: "Fetching video data...",
            progress: 0,
            status: "PENDING",
            createdAt: now,
            updatedAt: now,
            steps: {
                info: { status: "pending", progress: 0 },
                download: { status: "pending", progress: 0 },
                remux: { status: "pending", progress: 0 },
                subtitles: { status: "pending", progress: 0 },
            },
        };

        await this.redis.hset(`job:${jobId}`, jobData);
        await this.redis.sadd("active_jobs", jobId);
        await this.redis.expire(`job:${jobId}`, 86400); // 24 hours TTL

        return jobId;
    }

    async getJob(jobId: string): Promise<JobData | null> {
        const data = await this.redis.hgetall(`job:${jobId}`);
        if (!data.id) return null;

        // Parse steps safely
        let steps = {};
        if (data.steps) {
            try {
                steps = JSON.parse(data.steps);
            } catch {
                // If parsing fails, use default empty steps
                steps = {
                    info: { status: "pending", progress: 0 },
                    download: { status: "pending", progress: 0 },
                    remux: { status: "pending", progress: 0 },
                    subtitles: { status: "pending", progress: 0 },
                };
            }
        }

        return {
            id: data.id,
            url: data.url,
            title: data.title,
            progress: parseFloat(data.progress || "0"),
            status: data.status as JobData["status"],
            error: data.error,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            completedAt: data.completedAt,
            steps: steps as JobData["steps"],
        };
    }

    async updateJob(jobId: string, updates: Partial<JobData>): Promise<void> {
        const now = new Date().toISOString();
        const updateData: any = {
            ...updates,
            updatedAt: now,
        };

        // Serialize steps if present
        if (updateData.steps) {
            updateData.steps = JSON.stringify(updateData.steps);
        }

        await this.redis.hset(`job:${jobId}`, updateData);
    }

    async updateJobProgress(jobId: string, step: keyof JobData["steps"], progress: number): Promise<void> {
        const job = await this.getJob(jobId);
        if (!job) return;

        job.steps[step] = {
            ...job.steps[step],
            status: "active",
            progress,
        };

        // Calculate overall progress
        const stepProgresses = Object.values(job.steps).map(s => s.progress);
        const overallProgress = stepProgresses.reduce((sum, p) => sum + p, 0) / stepProgresses.length;

        // Update job with serialized steps
        const now = new Date().toISOString();
        await this.redis.hset(`job:${jobId}`, {
            progress: overallProgress.toString(),
            steps: JSON.stringify(job.steps),
            updatedAt: now,
        });
    }

    async completeJobStep(jobId: string, step: keyof JobData["steps"]): Promise<void> {
        const job = await this.getJob(jobId);
        if (!job) return;

        job.steps[step] = {
            ...job.steps[step],
            status: "completed",
            progress: 100,
        };

        // Update job with serialized steps
        const now = new Date().toISOString();
        await this.redis.hset(`job:${jobId}`, {
            steps: JSON.stringify(job.steps),
            updatedAt: now,
        });
    }

    async failJob(jobId: string, error: string): Promise<void> {
        await this.updateJob(jobId, {
            status: "FAILED",
            error,
        });
        await this.redis.srem("active_jobs", jobId);
        await this.redis.sadd("completed_jobs", jobId);
        await this.redis.expire(`job:${jobId}`, 3600); // 1 hour TTL for failed jobs
    }

    async completeJob(jobId: string): Promise<void> {
        await this.updateJob(jobId, {
            status: "COMPLETED",
            progress: 100,
            completedAt: new Date().toISOString(),
        });
        await this.redis.srem("active_jobs", jobId);
        await this.redis.sadd("completed_jobs", jobId);
        await this.redis.expire(`job:${jobId}`, 3600); // 1 hour TTL for completed jobs
    }

    async getActiveJobs(): Promise<JobData[]> {
        const jobIds = await this.redis.smembers("active_jobs");
        const jobs: JobData[] = [];

        for (const jobId of jobIds) {
            const job = await this.getJob(jobId);
            if (job) jobs.push(job);
        }

        return jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    async deleteJob(jobId: string): Promise<void> {
        await this.redis.del(`job:${jobId}`);
        await this.redis.srem("active_jobs", jobId);
        await this.redis.srem("completed_jobs", jobId);
    }
}

export const redisStore = RedisStore.getInstance();
