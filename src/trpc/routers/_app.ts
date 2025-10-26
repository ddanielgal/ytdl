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

      const job = await videoQueue.add("download video", {
        url,
        title: metadata.title,
      });

      return {
        metadata,
        jobId: job.id,
      };
    }),

  simpleAddVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation(async (opts) => {
      const { url } = opts.input;

      const rawMetadata = await yt.getVideoInfo(url);
      const metadata = z.object({ title: z.string() }).parse(rawMetadata);

      console.log("start", url);

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

      function handleProgress(...args: unknown[]) {
        globalEmitter.emit(url, ...args);
      }

      function handleYtdlpEvent(...args: unknown[]) {
        globalEmitter.emit(url, ...args);
      }

      function handleError(...args: unknown[]) {
        console.error(url, args);
        globalEmitter.emit(url, ...args);
        downloadEmitter.off("progress", handleProgress);
        downloadEmitter.off("ytDlpEvent", handleYtdlpEvent);
        downloadEmitter.off("error", handleError);
        downloadEmitter.off("close", handleClose);
      }

      function handleClose() {
        console.info("close", url);
        globalEmitter.emit(url, "finish");
        downloadEmitter.off("progress", handleProgress);
        downloadEmitter.off("ytDlpEvent", handleYtdlpEvent);
        downloadEmitter.off("error", handleError);
        downloadEmitter.off("close", handleClose);
      }

      downloadEmitter.on("progress", handleProgress);
      downloadEmitter.on("ytDlpEvent", handleYtdlpEvent);
      downloadEmitter.on("error", handleError);
      downloadEmitter.on("close", handleClose);

      return {
        metadata,
      };
    }),

  simpleVideoProgress: baseProcedure
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

  getQueueStats: baseProcedure.query(async () => {
    const waiting = await videoQueue.getWaiting();
    const active = await videoQueue.getActive();
    const completed = await videoQueue.getCompleted();
    const failed = await videoQueue.getFailed();

    const allJobs = [
      ...waiting.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        status: "waiting" as const,
        createdAt: job.timestamp,
      })),
      ...active.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        status: "active" as const,
        createdAt: job.timestamp,
        startedAt: job.processedOn,
      })),
      ...completed.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        status: "completed" as const,
        createdAt: job.timestamp,
        completedAt: job.finishedOn,
      })),
      ...failed.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        status: "failed" as const,
        createdAt: job.timestamp,
        failedAt: job.finishedOn,
        error: job.failedReason,
      })),
    ];

    allJobs.sort((a, b) => b.createdAt - a.createdAt);

    return {
      jobs: allJobs,
    };
  }),
});

export type AppRouter = typeof appRouter;
