import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import YTDlpWrap from "yt-dlp-wrap-plus";

const yt = new YTDlpWrap("/home/linuxbrew/.linuxbrew/bin/yt-dlp");

export const appRouter = createTRPCRouter({
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation((opts) => {
      yt.exec([
        "--write-info-json",
        "--write-thumbnail",
        "--output",
        "%(uploader)s/%(title)s [%(id)s]/%(title)s [%(id)s].%(ext)s",
        opts.input.url,
      ])
        .on("progress", (progress) =>
          console.log(
            progress.percent,
            progress.totalSize,
            progress.currentSpeed,
            progress.eta
          )
        )
        .on("ytDlpEvent", (eventType, eventData) =>
          console.log(eventType, eventData)
        )
        .on("error", (error) => console.error(error))
        .on("close", () => console.log("all done"));
      return {
        message: `downloading ${opts.input.url}`,
      };
    }),
});

// export type definition of API
export type AppRouter = typeof appRouter;
