import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";

export const appRouter = createTRPCRouter({
  addVideo: baseProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation((opts) => {
      return {
        message: `added ${opts.input.url}`,
      };
    }),
});

// export type definition of API
export type AppRouter = typeof appRouter;
