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

            // Update title and complete info step
            await redisStore.updateJob(jobId, { title: videoTitle });
            await redisStore.completeJobStep(jobId, "info");

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

            // Start download with comprehensive event tracking
            const downloadPromise = new Promise<void>((resolve, reject) => {
                let currentStep = "download";
                let remuxProgress = 0;
                let subtitleProgress = 0;

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
                        console.log(`Progress [${currentStep}]:`, percent + "%", progress);

                        // Update progress for current step
                        await redisStore.updateJobProgress(jobId, currentStep as keyof JobData["steps"], percent);

                        // Emit progress event for real-time updates
                        const jobData = await redisStore.getJob(jobId);
                        if (jobData) {
                            console.log("Emitting progress event:", {
                                jobId,
                                progress: jobData.progress,
                                status: jobData.status,
                                currentStep
                            });
                            progressEmitter.emit("progress", {
                                jobId,
                                url,
                                title: jobData.title,
                                progress: jobData.progress || 0,
                                status: jobData.status,
                                steps: jobData.steps,
                            });
                        }
                    })
                    .on("ytDlpEvent", (event) => {
                        console.log("yt-dlp event:", event);

                        // Detect step changes based on event string
                        if (typeof event === "string") {
                            const previousStep = currentStep;
                            if (event === "info") {
                                currentStep = "info";
                            } else if (event === "download") {
                                currentStep = "download";
                            } else if (event === "SubtitlesConvertor") {
                                currentStep = "subtitles";
                            } else if (event === "Merger") {
                                currentStep = "remux";
                            }

                            if (previousStep !== currentStep) {
                                console.log(`Step changed: ${previousStep} → ${currentStep}`);
                            }
                        }
                    })
                    .on("error", (error) => {
                        console.error("yt-dlp error:", error);
                        reject(error);
                    })
                    .on("close", (code) => {
                        console.log("yt-dlp process closed with code:", code);
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`yt-dlp exited with code ${code}`));
                        }
                    });
            });

            await downloadPromise;

            // Complete all remaining steps
            await redisStore.completeJobStep(jobId, "download");
            await redisStore.completeJobStep(jobId, "remux");
            await redisStore.completeJobStep(jobId, "subtitles");
            await redisStore.completeJob(jobId);

            // Emit completion event
            const jobData = await redisStore.getJob(jobId);
            if (jobData) {
                progressEmitter.emit("finish", {
                    jobId,
                    url,
                    title: jobData.title,
                    status: "COMPLETED",
                    steps: jobData.steps,
                });
            }

        } catch (error) {
            console.error("Download job failed:", error);

            // Get current job data
            const jobData = await redisStore.getJob(jobId);

            // Mark job as failed
            await redisStore.failJob(jobId, error instanceof Error ? error.message : "Unknown error");

            // Emit failure event
            progressEmitter.emit("finish", {
                jobId,
                url,
                title: jobData?.title || "Unknown",
                status: "FAILED",
                error: error instanceof Error ? error.message : "Unknown error",
                steps: jobData?.steps,
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