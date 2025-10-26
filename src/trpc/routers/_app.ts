import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import fs from "node:fs";
import EventEmitter from "node:events";
import { observable } from "@trpc/server/observable";
import { videoQueue } from "~/lib/queue";
import YTDlpWrap from "yt-dlp-wrap-plus";
import env from "~/env";

const yt = new YTDlpWrap(env.YTDLP_PATH);

const globalEmitter = new EventEmitter();

export const appRouter = createTRPCRouter({
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
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation(async (opts) => {
      const { url } = opts.input;

      const rawMetadata = await yt.getVideoInfo(url);
      const metadata = z.object({ title: z.string() }).parse(rawMetadata);

      // Add job to queue
      const job = await videoQueue.add("download video", {
        url,
        title: metadata.title,
      });

      return {
        metadata,
        jobId: job.id,
      };
    }),

  // Keep existing progress subscription (dead code for now)
  videoProgress: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .subscription((opts) => {
      const { url } = opts.input;

      return observable<string>((emit) => {
        function handleAllEvents(...args: unknown[]) {
          const message = JSON.stringify(args);
          emit.next(message);
        }

        globalEmitter.on(url, handleAllEvents);
        console.info("on", url);

        return () => {
          globalEmitter.off(url, handleAllEvents);
          console.info("off", url);
        };
      });
    }),

  // Queue status queries
  getQueueStats: baseProcedure.query(async () => {
    const waiting = await videoQueue.getWaiting();
    const active = await videoQueue.getActive();
    const completed = await videoQueue.getCompleted();
    const failed = await videoQueue.getFailed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      jobs: {
        waiting: waiting.map((job) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          createdAt: job.timestamp,
        })),
        active: active.map((job) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          startedAt: job.processedOn,
        })),
        completed: completed.map((job) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          completedAt: job.finishedOn,
        })),
        failed: failed.map((job) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          failedAt: job.finishedOn,
          error: job.failedReason,
        })),
      },
    };
  }),

  getJobStatus: baseProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input }) => {
      const job = await videoQueue.getJob(input.jobId);
      if (!job) return null;

      return {
        id: job.id,
        name: job.name,
        data: job.data,
        state: await job.getState(),
        createdAt: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
      };
    }),
});

export type AppRouter = typeof appRouter;
