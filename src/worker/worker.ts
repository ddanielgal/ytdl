import "dotenv/config";
import { Worker, Job } from "bullmq";
import YTDlpWrap from "yt-dlp-wrap-plus";
import env from "~/env";
import { VideoJobData } from "~/lib/queue";

const yt = new YTDlpWrap(env.YTDLP_PATH);

const redisConfig = {
  host: env.REDIS_HOST,
  port: parseInt(env.REDIS_PORT),
};

const worker = new Worker(
  "ytdl",
  async (job: Job<VideoJobData>) => {
    const { url, title } = job.data;

    console.log(`Starting download for: ${title} (${url})`);

    const downloadEmitter = yt.exec([
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
      "--ignore-errors",
      "--extractor-args",
      "youtube:player_js_version=actual",
      "--output",
      "data/videos/%(uploader)s/%(upload_date>%Y)s/%(upload_date)s %(title)s/%(title)s.%(ext)s",
      url,
    ]);

    return new Promise((resolve, reject) => {
      function handleProgress(...args: unknown[]) {
        console.debug(`[${title}] Progress:`, ...args);
      }

      function handleYtdlpEvent(...args: unknown[]) {
        console.debug(`[${title}] yt-dlp event:`, ...args);
      }

      function handleClose() {
        console.log(`Download completed for: ${title}`);
        downloadEmitter.off("progress", handleProgress);
        downloadEmitter.off("ytDlpEvent", handleYtdlpEvent);
        downloadEmitter.off("error", handleError);
        downloadEmitter.off("close", handleClose);
        resolve({ success: true, url, title });
      }

      function handleError(error: Error) {
        console.error(`Download failed for ${title}:`, error);
        downloadEmitter.off("progress", handleProgress);
        downloadEmitter.off("ytDlpEvent", handleYtdlpEvent);
        downloadEmitter.off("error", handleError);
        downloadEmitter.off("close", handleClose);
        reject(error);
      }

      downloadEmitter.on("progress", handleProgress);
      downloadEmitter.on("ytDlpEvent", handleYtdlpEvent);
      downloadEmitter.on("close", handleClose);
      downloadEmitter.on("error", handleError);
    });
  },
  {
    connection: redisConfig,
    concurrency: 1,
  }
);

console.log("Worker started and listening for jobs...");

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

worker.on("failed", (job, err) => {
  console.log(`Job ${job?.id} failed:`, err.message);
});
