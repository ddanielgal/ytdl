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
        };

        await this.redis.hset(`job:${jobId}`, jobData);
        await this.redis.sadd("active_jobs", jobId);

        return jobId;
    }

    async getJob(jobId: string): Promise<JobData | null> {
        const data = await this.redis.hgetall(`job:${jobId}`);
        if (!data.id) return null;

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
        };
    }

    async updateJob(jobId: string, updates: Partial<JobData>): Promise<void> {
        const now = new Date().toISOString();
        const updateData: any = {
            ...updates,
            updatedAt: now,
        };

        await this.redis.hset(`job:${jobId}`, updateData);
    }


    async failJob(jobId: string, error: string): Promise<void> {
        await this.updateJob(jobId, {
            status: "FAILED",
            error,
        });
        await this.redis.srem("active_jobs", jobId);
    }

    async completeJob(jobId: string): Promise<void> {
        await this.updateJob(jobId, {
            status: "COMPLETED",
            progress: 100,
            completedAt: new Date().toISOString(),
        });
        await this.redis.srem("active_jobs", jobId);
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
    }
}

export const redisStore = RedisStore.getInstance();
