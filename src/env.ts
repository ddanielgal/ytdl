import { z } from "zod";

const env = z.object({
    YTDLP_PATH: z.string(),
    DATABASE_URL: z.string().default("file:./dev.db"),
    REDIS_URL: z.string().default("redis://localhost:6379")
}).parse(process.env);

export default env;
