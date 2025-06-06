import { z } from "zod";

const env = z.object({ YTDLP_PATH: z.string() }).parse(process.env);

export default env;
