import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import YTDlpWrap from "yt-dlp-wrap-plus";
import fs from "node:fs";
import EventEmitter, { on } from "node:events";

const yt = new YTDlpWrap("/home/linuxbrew/.linuxbrew/bin/yt-dlp");

const progressEmitter = new EventEmitter();

export const appRouter = createTRPCRouter({
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation((opts) => {
      yt.exec([
        "-f bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--write-info-json",
        "--write-thumbnail",
        "--output",
        "data/%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s]/%(title)s [%(id)s].%(ext)s",
        opts.input.url,
      ])
        .on("progress", (progress) => {
          console.log(
            progress.percent,
            progress.totalSize,
            progress.currentSpeed,
            progress.eta
          );
          progressEmitter.emit("progress", {
            url: opts.input.url,
            percent: progress.percent,
          });
        })
        .on("ytDlpEvent", (eventType, eventData) =>
          console.log(eventType, eventData)
        )
        .on("error", (error) => console.error(error))
        .on("close", () => {
          console.log("all done");
          progressEmitter.emit("finish", {
            url: opts.input.url,
          });
        });
      return {
        message: `downloading ${opts.input.url}`,
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
