import tailwindcss from "bun-plugin-tailwind";

const server = await Bun.build({
  entrypoints: ["./server.ts"],
  target: "bun",
  minify: true,
  plugins: [tailwindcss],
  compile: {
    outfile: "./ytdl",
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
    outfile: "./ytdl-worker",
  },
});

if (!worker.success) {
  console.error("Worker build failed:");
  for (const log of worker.logs) {
    console.error(log);
  }
  process.exit(1);
}
