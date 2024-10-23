import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import YTDlpWrap from "yt-dlp-wrap-plus";
import fs from "node:fs";
import EventEmitter, { on } from "node:events";
import { debounce } from "remeda";

const yt = new YTDlpWrap("/app/bin/yt-dlp");

const progressEmitter = new EventEmitter();

const progressMap = new Map<string, { url: string; percent: number }>();

const debouncer = debounce(
  () => {
    progressMap.forEach((progress) => {
      progressEmitter.emit("progress", progress);
    });
    progressMap.clear();
  },
  { maxWaitMs: 500 }
);

function emitProgress(url: string, percent: number) {
  progressMap.set(url, { url, percent });
  debouncer.call();
}

export const appRouter = createTRPCRouter({
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation(async (opts) => {
      const rawMetadata = await yt.getVideoInfo(opts.input.url);
      const metadata = z.object({ title: z.string() }).parse(rawMetadata);

      yt.exec([
        "-f bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--write-info-json",
        "--write-thumbnail",
        "--output",
        "data/videos/%(uploader)s/%(upload_date>%Y)s/%(title)s/%(title)s.%(ext)s",
        opts.input.url,
      ])
        .on("progress", (progress) => {
          emitProgress(opts.input.url, Number(progress.percent));
        })
        // .on("ytDlpEvent", (...args) => console.log("ytdlpevent", args))
        .on("error", (error) => console.error(error))
        .on("close", () => {
          progressEmitter.emit("finish", {
            url: opts.input.url,
          });
        });
      return {
        metadata,
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
  videoProgress: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .subscription(async function* (opts) {
      for await (const [data] of on(progressEmitter, "progress")) {
        if (data.url !== opts.input.url) {
          continue;
        }
        const url: string = data.url;
        const percent: number = data.percent;
        yield { url, percent };
      }
    }),

  videoFinished: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .subscription(async function* (opts) {
      for await (const [data] of on(progressEmitter, "finish")) {
        if (data.url !== opts.input.url) {
          continue;
        }
        const url: string = data.url;
        yield { url };
      }
    }),
});

// export type definition of API
export type AppRouter = typeof appRouter;
