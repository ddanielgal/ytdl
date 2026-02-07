import tailwindcss from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./server.ts"],
  target: "bun",
  minify: true,
  plugins: [tailwindcss],
  compile: {
    outfile: "./ytdl",
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
