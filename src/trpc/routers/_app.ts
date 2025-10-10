import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import { downloadQueue, worker } from "~/lib/queue";
import { redisStore } from "~/lib/redis-store";
import { progressEmitter } from "~/lib/events";
import fs from "node:fs";
import { on } from "node:events";

// Ensure worker is started
console.log("Worker started:", worker.name);

export const appRouter = createTRPCRouter({
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation(async (opts) => {
      const { url } = opts.input;

      // Check if job already exists in Redis
      const activeJobs = await redisStore.getActiveJobs();
      const existingJob = activeJobs.find(job => job.url === url);

      if (existingJob) {
        // If job is pending or active, return existing job
        if (existingJob.status === "PENDING" || existingJob.status === "ACTIVE") {
          return {
            metadata: { title: existingJob.title },
            jobId: existingJob.id,
          };
        }

        // If job failed or completed, delete it and create a new one
        if (existingJob.status === "FAILED" || existingJob.status === "COMPLETED") {
          await redisStore.deleteJob(existingJob.id);
        }
      }

      // Create new job in Redis
      const jobId = await redisStore.createJob(url);

      // Add job to BullMQ queue
      const bullJob = await downloadQueue.add("download", {
        url,
        jobId,
      });

      console.log("Added job to queue:", bullJob.id, "for URL:", url);

      return {
        metadata: { title: "Fetching video data..." },
        jobId,
      };
    }),

  listVideos: baseProcedure.query(async () => {
    const folders = await fs.promises.readdir("data", {
      withFileTypes: true,
      recursive: true,
    });
    const videos = folders.filter(
      (folder) => folder.isDirectory() && folder.parentPath !== "data"
    );

    return videos;
  }),

  // Get all active jobs for persistent progress
  getActiveJobs: baseProcedure.query(async () => {
    const jobs = await redisStore.getActiveJobs();
    return jobs.map(job => ({
      id: job.id,
      url: job.url,
      title: job.title,
      progress: job.progress,
      status: job.status,
      steps: job.steps,
    }));
  }),

  // Get job progress by ID
  getJobProgress: baseProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input }) => {
      const job = await redisStore.getJob(input.jobId);

      if (!job) {
        throw new Error("Job not found");
      }

      return {
        id: job.id,
        url: job.url,
        title: job.title,
        progress: job.progress,
        status: job.status,
        error: job.error,
        steps: job.steps,
      };
    }),

  // Real-time progress subscription
  jobProgress: baseProcedure
    .input(
      z.object({
        jobId: z.string(),
      })
    )
    .subscription(async function* (opts) {
      // First, get current progress from Redis
      const job = await redisStore.getJob(opts.input.jobId);

      if (job) {
        yield {
          jobId: job.id,
          url: job.url,
          title: job.title,
          progress: job.progress,
          status: job.status,
          error: job.error,
          steps: job.steps,
        };
      }

      // Then listen for real-time updates
      console.log("Listening for progress events for jobId:", opts.input.jobId);
      for await (const [data] of on(progressEmitter, "progress")) {
        console.log("Received progress event:", data);
        if (data.jobId !== opts.input.jobId) {
          console.log("Skipping event for different jobId:", data.jobId);
          continue;
        }
        console.log("Yielding progress event for jobId:", data.jobId);
        yield data;
      }
    }),

  // Job finished subscription
  jobFinished: baseProcedure
    .input(
      z.object({
        jobId: z.string(),
      })
    )
    .subscription(async function* (opts) {
      for await (const [data] of on(progressEmitter, "finish")) {
        if (data.jobId !== opts.input.jobId) {
          continue;
        }
        yield data;
      }
    }),
});

// export type definition of API
export type AppRouter = typeof appRouter;