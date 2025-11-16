import { Queue } from "bullmq";
import env from "~/env";

const redisConfig = {
  host: env.REDIS_HOST,
  port: parseInt(env.REDIS_PORT),
};

export const videoQueue = new Queue("ytdl", {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 1,
  },
});

export type VideoJobData = {
  url: string;
  title?: string;
  uploader?: string;
};
