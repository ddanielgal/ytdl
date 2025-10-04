import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import { downloadQueue } from "~/lib/queue";
import { db } from "~/lib/db";
import { progressEmitter } from "~/lib/events";
import fs from "node:fs";
import { on } from "node:events";

export const appRouter = createTRPCRouter({
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation(async (opts) => {
      const { url } = opts.input;

      // Check if job already exists
      const existingJob = await db.downloadJob.findUnique({
        where: { url },
      });

      if (existingJob) {
        // If job is pending or active, return existing job
        if (existingJob.status === "PENDING" || existingJob.status === "ACTIVE") {
          return {
            metadata: { title: existingJob.title || "Unknown" },
            jobId: existingJob.id,
          };
        }

        // If job failed or completed, delete it and create a new one
        if (existingJob.status === "FAILED" || existingJob.status === "COMPLETED") {
          await db.downloadJob.delete({
            where: { id: existingJob.id },
          });
        }
      }

      // Create new job in database
      const job = await db.downloadJob.create({
        data: {
          url,
          status: "PENDING",
          progress: 0,
        },
      });

      // Add job to BullMQ queue
      const bullJob = await downloadQueue.add("download", {
        url,
        dbJobId: job.id,
      });

      // Update job with BullMQ job ID
      await db.downloadJob.update({
        where: { id: job.id },
        data: { bullJobId: bullJob.id },
      });

      return {
        metadata: { title: job.title || "Unknown" },
        jobId: job.id,
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
    // Clean up old completed/failed jobs (older than 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.downloadJob.deleteMany({
      where: {
        status: {
          in: ["COMPLETED", "FAILED"],
        },
        updatedAt: {
          lt: oneHourAgo,
        },
      },
    });

    const jobs = await db.downloadJob.findMany({
      where: {
        status: {
          in: ["PENDING", "ACTIVE"],
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return jobs.map(job => ({
      id: job.id,
      url: job.url,
      title: job.title || "Unknown",
      progress: job.progress,
      status: job.status,
    }));
  }),

  // Get job progress by ID
  getJobProgress: baseProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input }) => {
      const job = await db.downloadJob.findUnique({
        where: { id: input.jobId },
      });

      if (!job) {
        throw new Error("Job not found");
      }

      return {
        id: job.id,
        url: job.url,
        title: job.title || "Unknown",
        progress: job.progress,
        status: job.status,
        error: job.error,
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
      // First, get current progress from database
      const job = await db.downloadJob.findUnique({
        where: { id: opts.input.jobId },
      });

      if (job) {
        yield {
          jobId: job.id,
          url: job.url,
          title: job.title || "Unknown",
          progress: job.progress,
          status: job.status,
          error: job.error,
        };
      }

      // Then listen for real-time updates
      for await (const [data] of on(progressEmitter, "progress")) {
        if (data.jobId !== opts.input.jobId) {
          continue;
        }
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
