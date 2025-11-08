import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import fs from "node:fs";
import EventEmitter from "node:events";
import { observable } from "@trpc/server/observable";
import { videoQueue } from "~/lib/queue";
import YTDlpWrap from "yt-dlp-wrap-plus";
import env from "~/env";
import Parser from "rss-parser";

const yt = new YTDlpWrap(env.YTDLP_PATH);

const globalEmitter = new EventEmitter();

const rssParser = new Parser();

// Zod schema for YouTube RSS feed items
const youtubeFeedItemSchema = z.object({
  title: z.string(),
  link: z.string().url(),
  pubDate: z.string(),
  author: z.string(),
});

const youtubeFeedSchema = z.object({
  title: z.string(),
  items: z.array(youtubeFeedItemSchema),
});

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
      const metadata = z
        .object({ title: z.string(), uploader: z.string() })
        .parse(rawMetadata);

      const job = await videoQueue.add("download video", {
        url,
        title: metadata.title,
        uploader: metadata.uploader,
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

  deleteFailedJob: baseProcedure
    .input(
      z.object({
        jobId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const { jobId } = input;

      const job = await videoQueue.getJob(jobId);

      if (!job) {
        throw new Error("Job not found");
      }

      await job.remove();

      return {
        deletedJobId: jobId,
      };
    }),

  getQueueStats: baseProcedure
    .input(
      z.object({
        limit: z.number().min(1).default(20),
        cursor: z.number().nullish(),
      })
    )
    .query(async ({ input }) => {
      const { limit, cursor } = input;
      const start = cursor ?? 0;
      const end = start + limit - 1;

      const allJobs = await videoQueue.getJobs(
        ["failed", "active", "wait", "completed"],
        start,
        end,
        false // desc order
      );

      const jobs = allJobs.map((job) => {
        if (!job.id) {
          throw new Error("Job has no id");
        }
        if (job.failedReason) {
          return {
            id: job.id,
            name: job.name,
            data: job.data,
            status: "failed" as const,
            failedReason: job.failedReason,
          };
        } else if (job.finishedOn && !job.failedReason) {
          return {
            id: job.id,
            name: job.name,
            data: job.data,
            status: "completed" as const,
          };
        } else if (job.processedOn && !job.finishedOn) {
          return {
            id: job.id,
            name: job.name,
            data: job.data,
            status: "active" as const,
          };
        } else {
          return {
            id: job.id,
            name: job.name,
            data: job.data,
            status: "waiting" as const,
          };
        }
      });

      const counts = await videoQueue.getJobCounts(
        "wait",
        "active",
        "completed",
        "failed"
      );

      const totalJobs =
        counts.wait + counts.active + counts.completed + counts.failed;

      const nextCursor = end < totalJobs - 1 ? end + 1 : null;

      return {
        jobs,
        nextCursor,
        totalJobs,
      };
    }),

  getYoutubeFeed: baseProcedure.query(async () => {
    const feedUrl =
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA";

    const feed = await rssParser.parseURL(feedUrl);

    // Extract channel name from feed title
    const channelName = feed.title ?? "Unknown Channel";

    // Parse and validate feed items
    const feedItems = feed.items.map((item) => {
      const parsed = youtubeFeedItemSchema.parse({
        title: item.title ?? "",
        link: item.link ?? "",
        pubDate: item.pubDate ?? "",
        author: item.author ?? channelName,
      });

      return {
        title: parsed.title,
        videoUrl: parsed.link,
        uploadDate: parsed.pubDate,
        channelName: parsed.author,
      };
    });

    return {
      channelName,
      items: feedItems,
    };
  }),
});

export type AppRouter = typeof appRouter;
