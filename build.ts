import tailwindcss from "bun-plugin-tailwind";
import { mkdir } from "fs/promises";

const supportedTargets = ["bun-linux-x64", "bun-linux-arm64"] as const;
type BuildTarget = (typeof supportedTargets)[number];

const buildTarget = process.env.BUILD_TARGET;

if (buildTarget && !supportedTargets.includes(buildTarget as BuildTarget)) {
  console.error(
    `Unsupported BUILD_TARGET: ${buildTarget}. Expected one of: ${supportedTargets.join(", ")}`,
  );
  process.exit(1);
}

const target = buildTarget as BuildTarget | undefined;

await mkdir("./dist", { recursive: true });

const server = await Bun.build({
  entrypoints: ["./server.ts"],
  target: "bun",
  minify: true,
  plugins: [tailwindcss],
  compile: {
    outfile: "./dist/ytdl",
    ...(target ? { target } : {}),
  },
});

if (!server.success) {
  console.error("Server build failed:");
  for (const log of server.logs) {
    console.error(log);
  }
  process.exit(1);
}

const worker = await Bun.build({
  entrypoints: ["./src/worker/worker.ts"],
  target: "bun",
  minify: true,
  compile: {
    outfile: "./dist/ytdl-worker",
    ...(target ? { target } : {}),
  },
});

if (!worker.success) {
  console.error("Worker build failed:");
  for (const log of worker.logs) {
    console.error(log);
  }
  process.exit(1);
}
