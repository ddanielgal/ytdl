import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import YTDlpWrap from "yt-dlp-wrap-plus";
import { redisStore, JobData } from "./redis-store";
import { progressEmitter } from "./events";
import env from "~/env";

// Redis connection
const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
});

// Create queue - simplified, no retries
export const downloadQueue = new Queue("download", {
    connection: redis,
    defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 1, // No retries - fail fast for visibility
        delay: 1000, // Small delay before processing
    },
});

// Job data interface
export interface DownloadJobData {
    url: string;
    jobId: string;
}

// Worker for processing download jobs
const worker = new Worker(
    "download",
    async (job: Job<DownloadJobData>) => {
        const { url, jobId } = job.data;
        console.log("Worker processing job:", job.id, "for URL:", url);

        try {
            // Update job status to ACTIVE
            await redisStore.updateJob(jobId, { status: "ACTIVE" });

            // Initialize yt-dlp
            const yt = new YTDlpWrap(env.YTDLP_PATH);

            // Get video info first
            console.log("Fetching video info for:", url);
            const metadata = await yt.getVideoInfo(url);
            const videoTitle = metadata.title || "Unknown";
            console.log("Video title:", videoTitle);

            // Update title
            await redisStore.updateJob(jobId, { title: videoTitle });

            // Emit initial progress event after title update
            console.log("Emitting initial progress event after title update");
            progressEmitter.emit("progress", {
                jobId,
                url,
                title: videoTitle,
                progress: 0,
                status: "ACTIVE",
                steps: {
                    info: { status: "completed", progress: 100 },
                    download: { status: "pending", progress: 0 },
                    remux: { status: "pending", progress: 0 },
                    subtitles: { status: "pending", progress: 0 },
                },
            });

            // Start download with comprehensive event tracking and log streaming
            const downloadPromise = new Promise<void>((resolve, reject) => {
                let currentStep = "download";

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
                        const percent = Number(progress.percent) || 0;
                        console.log(`Progress:`, percent + "%", progress);

                        // Update progress in Redis
                        await redisStore.updateJob(jobId, { progress: percent });

                        // Emit progress event for real-time updates
                        progressEmitter.emit("progress", {
                            jobId,
                            url,
                            title: videoTitle,
                            progress: percent,
                            status: "ACTIVE",
                        });
                    })
                    .on("ytDlpEvent", (event) => {
                        // Stream yt-dlp events to UI for debugging
                        if (typeof event === "string") {
                            console.log("yt-dlp event:", event);
                            progressEmitter.emit("log", {
                                jobId,
                                line: event,
                                timestamp: new Date().toISOString(),
                            });
                        }
                    })
                    .on("error", (error) => {
                        console.error("yt-dlp error:", error);
                        // Stream error to UI
                        progressEmitter.emit("log", {
                            jobId,
                            line: `ERROR: ${error.message}`,
                            timestamp: new Date().toISOString(),
                        });
                        reject(error);
                    })
                    .on("close", (code) => {
                        console.log("yt-dlp process closed with code:", code);
                        if (code === 0) {
                            resolve();
                        } else {
                            const errorMsg = `yt-dlp exited with code ${code}`;
                            console.error(errorMsg);
                            // Stream exit code to UI
                            progressEmitter.emit("log", {
                                jobId,
                                line: `EXIT: ${errorMsg}`,
                                timestamp: new Date().toISOString(),
                            });
                            reject(new Error(errorMsg));
                        }
                    });
            });

            await downloadPromise;

            // Mark job as completed
            await redisStore.completeJob(jobId);

            // Emit completion event
            progressEmitter.emit("finish", {
                jobId,
                url,
                title: videoTitle,
                status: "COMPLETED",
            });

        } catch (error) {
            console.error("Download job failed:", error);

            // Get current job data for title
            const jobData = await redisStore.getJob(jobId);
            const title = jobData?.title || "Unknown";

            // Mark job as failed
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            await redisStore.failJob(jobId, errorMessage);

            // Emit failure event
            progressEmitter.emit("finish", {
                jobId,
                url,
                title,
                status: "FAILED",
                error: errorMessage,
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