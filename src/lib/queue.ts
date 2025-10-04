import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import YTDlpWrap from "yt-dlp-wrap-plus";
import { db } from "./db";
import { progressEmitter } from "./events";
import env from "~/env";
import fs from "node:fs";
import path from "node:path";

// Redis connection
const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
});

// Create queue
export const downloadQueue = new Queue("download", {
    connection: redis,
    defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 2000,
        },
        delay: 1000, // Add small delay before processing
    },
});

// Job data interface
export interface DownloadJobData {
    url: string;
    title?: string;
    dbJobId: string;
}

// Worker for processing download jobs
const worker = new Worker(
    "download",
    async (job: Job<DownloadJobData>) => {
        const { url, title, dbJobId } = job.data;

        try {
            // Update job status to ACTIVE
            await db.downloadJob.update({
                where: { id: dbJobId },
                data: {
                    status: "ACTIVE",
                    bullJobId: job.id,
                },
            });

            // Initialize yt-dlp
            const yt = new YTDlpWrap(env.YTDLP_PATH);

            // Get video info first
            const metadata = await yt.getVideoInfo(url);
            const videoTitle = metadata.title || title || "Unknown";

            // Update title in database
            await db.downloadJob.update({
                where: { id: dbJobId },
                data: { title: videoTitle },
            });

            // Start download with progress tracking
            const downloadPromise = new Promise<void>((resolve, reject) => {
                yt.exec([
                    "-f",
                    "bv*[height<=1080]+ba/b",
                    "--write-info-json",
                    "--write-thumbnail",
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs",
                    "en,en-orig,hu,hu-orig",
                    "--convert-subs",
                    "srt",
                    "--output",
                    "data/videos/%(uploader)s/%(upload_date>%Y)s/%(upload_date)s %(title)s/%(title)s.%(ext)s",
                    url,
                ])
                    .on("progress", async (progress) => {
                        const percent = Number(progress.percent);

                        // Update progress in database
                        await db.downloadJob.update({
                            where: { id: dbJobId },
                            data: { progress: percent },
                        });

                        // Update job progress
                        await job.updateProgress(percent);

                        // Emit progress event for real-time updates
                        progressEmitter.emit("progress", {
                            jobId: dbJobId,
                            url,
                            title: videoTitle,
                            progress: percent,
                            status: "ACTIVE",
                        });
                    })
                    .on("error", (error) => {
                        console.error("yt-dlp error:", error);
                        reject(error);
                    })
                    .on("close", (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`yt-dlp exited with code ${code}`));
                        }
                    });
            });

            await downloadPromise;

            // Mark job as completed
            await db.downloadJob.update({
                where: { id: dbJobId },
                data: {
                    status: "COMPLETED",
                    progress: 100,
                    completedAt: new Date(),
                },
            });

            // Emit completion event
            progressEmitter.emit("finish", {
                jobId: dbJobId,
                url,
                title: videoTitle,
                status: "COMPLETED",
            });

        } catch (error) {
            console.error("Download job failed:", error);

            // Get current job title from database
            const job = await db.downloadJob.findUnique({
                where: { id: dbJobId },
                select: { title: true },
            });

            // Mark job as failed
            await db.downloadJob.update({
                where: { id: dbJobId },
                data: {
                    status: "FAILED",
                    error: error instanceof Error ? error.message : "Unknown error",
                },
            });

            // Emit failure event
            progressEmitter.emit("finish", {
                jobId: dbJobId,
                url,
                title: job?.title || "Unknown",
                status: "FAILED",
                error: error instanceof Error ? error.message : "Unknown error",
            });

            throw error;
        }
    },
    {
        connection: redis,
        concurrency: 1, // Limit concurrent downloads
    }
);

// Worker event handlers
worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id || 'unknown'} failed:`, err);
});

worker.on("error", (err) => {
    console.error("Worker error:", err);
});

export { worker };
