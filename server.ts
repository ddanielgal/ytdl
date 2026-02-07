import { serve } from "bun";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createTRPCContext } from "~/trpc/init";
import { appRouter } from "~/trpc/routers/_app";

const BASE_PATH = "/ytdl";
const TRPC_PREFIX = `${BASE_PATH}/api/trpc`;

// Fullstack: default HTML import so Bun bundles <script> & <link>, serves via routes (see bun.com/docs/bundler/fullstack)
import indexHtml from "./public/index.html";

const tRPCHandler = (req: Request) =>
  fetchRequestHandler({
    endpoint: TRPC_PREFIX,
    req,
    router: appRouter,
    createContext: createTRPCContext,
  });

const isDev = process.env.NODE_ENV !== "production";

serve({
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  development: isDev ? { hmr: true, console: true } : false,
  routes: {
    [BASE_PATH]: indexHtml,
    [`${BASE_PATH}/`]: indexHtml,
    [`${BASE_PATH}/queue`]: indexHtml,
    [`${BASE_PATH}/queue/`]: indexHtml,
  },

  fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // tRPC API
    if (pathname.startsWith(TRPC_PREFIX)) {
      return tRPCHandler(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});
