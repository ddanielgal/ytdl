import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import YTDlpWrap from "yt-dlp-wrap-plus";
import fs from "node:fs";
import EventEmitter, { on } from "node:events";
import env from "~/env";
import { observable } from "@trpc/server/observable";

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
        "--output",
        "data/videos/%(uploader)s/%(upload_date>%Y)s/%(upload_date)s %(title)s/%(title)s.%(ext)s",
        url,
      ])


      function handleProgress(progress: unknown) {
        globalEmitter.emit(url, progress);

      }

      function handleYtdlpEvent(event: unknown) {
        globalEmitter.emit(url, event);
      }

      function handleError(error: unknown) {
        globalEmitter.emit(url, error);
        downloadEmitter.off("progress", handleProgress);
        downloadEmitter.off("ytDlpEvent", handleYtdlpEvent);
        downloadEmitter.off("error", handleError);
        downloadEmitter.off("close", handleClose);
      }

      function handleClose() {
        globalEmitter.emit(url, "finish");
        downloadEmitter.off("progress", handleProgress);
        downloadEmitter.off("ytDlpEvent", handleYtdlpEvent);
        downloadEmitter.off("error", handleError);
        downloadEmitter.off("close", handleClose);
      }

      downloadEmitter.on("progress", handleProgress)
      downloadEmitter.on("ytDlpEvent", handleYtdlpEvent)
      downloadEmitter.on("error", handleError)
      downloadEmitter.on("close", handleClose)

      return {
        metadata,
      };
    }),

  videoProgress: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .subscription((opts) => {
      const { url } = opts.input;

      return observable<string>((emit) => {
        function handleProgress(data: unknown) {
          emit.next(data as string);
        }

        globalEmitter.on(url, handleProgress);

        return () => {
          globalEmitter.off(url, handleProgress);

        };
      });
    }),


});

// export type definition of API
export type AppRouter = typeof appRouter;
