import { z } from "zod";

const env = z
  .object({
    YTDLP_PATH: z.string(),
    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.string().default("6379"),
  })
  .parse(process.env);

export default env;
