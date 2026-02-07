import { serve } from "bun";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createTRPCContext } from "~/trpc/init";
import { appRouter } from "~/trpc/routers/_app";

const BASE_PATH = "/ytdl";
const TRPC_PREFIX = `${BASE_PATH}/api/trpc`;

// HTML entry for the SPA (Bun bundles script/link from this file)
import indexHtml from "./public/index.html";

const tRPCHandler = (req: Request) =>
  fetchRequestHandler({
    endpoint: TRPC_PREFIX,
    req,
    router: appRouter,
    createContext: createTRPCContext,
  });

serve({
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  development: process.env.NODE_ENV !== "production",
  routes: {
    [BASE_PATH]: indexHtml,
    [`${BASE_PATH}/`]: indexHtml,
  },
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // tRPC API
    if (pathname.startsWith(TRPC_PREFIX)) {
      return tRPCHandler(req);
    }

    // SPA: any other path under basePath serves the shell (client-side routing)
    if (pathname === BASE_PATH || pathname.startsWith(BASE_PATH + "/")) {
      if (indexHtml instanceof Response) return indexHtml;
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});
