import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import fs from "node:fs";
import { videoQueue } from "~/lib/queue";
import Parser from "rss-parser";

const rssParser = new Parser();

// Zod schema for YouTube RSS feed items
const youtubeFeedItemSchema = z.object({
  title: z.string(),
  link: z.string().url(),
  pubDate: z.string(),
  author: z.string(),
  duration: z.number().optional(),
});

const youtubeFeedSchema = z.object({
  title: z.string(),
  items: z.array(youtubeFeedItemSchema),
});

// Normalize YouTube URL for comparison (remove query parameters)
function normalizeYoutubeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Keep only the pathname and search params that matter (v parameter)
    const videoId = urlObj.searchParams.get("v");
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    // Fallback to base URL without query params
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

export const appRouter = createTRPCRouter({
  listVideos: baseProcedure.query(async () => {
    const folders = await fs.promises.readdir("data", {
      withFileTypes: true,
      recursive: true,
    });
    const videos = folders.filter(
      (folder) => folder.isDirectory() && folder.parentPath !== "data",
    );

    return videos;
  }),

  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      }),
    )
    .mutation(async (opts) => {
      const { url } = opts.input;

      const job = await videoQueue.add("download video", {
        url,
      });

      return {
        jobId: job.id,
      };
    }),

  deleteFailedJob: baseProcedure
    .input(
      z.object({
        jobId: z.string(),
      }),
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
      }),
    )
    .query(async ({ input }) => {
      const { limit, cursor } = input;
      const start = cursor ?? 0;
      const end = start + limit - 1;

      const allJobs = await videoQueue.getJobs(
        ["failed", "active", "wait", "completed"],
        start,
        end,
        false, // desc order
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
        "failed",
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

  getYoutubeFeed: baseProcedure
    .input(
      z.object({
        channelId: z.string(),
      }),
    )
    .query(async (opts) => {
      const { channelId } = opts.input;
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

      const feed = await rssParser.parseURL(feedUrl);

      // Extract channel name from feed title
      const channelName = feed.title ?? "Unknown Channel";

      // Get all jobs from the queue to match with feed items
      const allJobs = await videoQueue.getJobs(
        ["failed", "active", "wait", "completed"],
        0,
        -1, // Get all jobs
      );

      // Create a map of normalized URL -> status
      const urlToStatusMap = new Map<
        string,
        "waiting" | "active" | "completed" | "failed"
      >();

      for (const job of allJobs) {
        if (job.data && typeof job.data === "object" && "url" in job.data) {
          const url = job.data.url as string;
          const normalizedUrl = normalizeYoutubeUrl(url);
          if (job.failedReason) {
            urlToStatusMap.set(normalizedUrl, "failed");
          } else if (job.finishedOn && !job.failedReason) {
            urlToStatusMap.set(normalizedUrl, "completed");
          } else if (job.processedOn && !job.finishedOn) {
            urlToStatusMap.set(normalizedUrl, "active");
          } else {
            urlToStatusMap.set(normalizedUrl, "waiting");
          }
        }
      }

      // Parse and validate feed items, enriching with queue status
      // Filter out Shorts (videos with /shorts/ in the URL)
      const feedItems = feed.items
        .filter((item) => {
          // Check if the link contains /shorts/ to filter out YouTube Shorts
          if (item.link) {
            return !item.link.includes("/shorts/");
          }
          return true; // Keep items without links (shouldn't happen, but be safe)
        })
        .map((item) => {
          const parsed = youtubeFeedItemSchema.parse({
            title: item.title ?? "",
            link: item.link ?? "",
            pubDate: item.pubDate ?? "",
            author: item.author ?? channelName,
          });

          const normalizedFeedUrl = normalizeYoutubeUrl(parsed.link);
          const queueStatus = urlToStatusMap.get(normalizedFeedUrl) ?? null;

          return {
            title: parsed.title,
            videoUrl: parsed.link,
            uploadDate: parsed.pubDate,
            channelName: parsed.author,
            queueStatus,
            duration: parsed.duration,
          };
        });

      return {
        channelName,
        items: feedItems,
      };
    }),
});

export type AppRouter = typeof appRouter;
