"use client";

import { trpc } from "~/trpc/client";
import { removeVideo, setProgress } from "./actions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useVideo } from "./VideoContext";
import { Progress } from "~/components/ui/progress";

export default function VideoProgress() {
  const { url, title, progress } = useVideo();
  trpc.videoProgress.useSubscription(
    { url },
    {
      onData: (data) => {
        setProgress(url, data.percent);
      },
    }
  );
  trpc.videoFinished.useSubscription(
    { url },
    {
      onData: () => {
        removeVideo(url);
      },
    }
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{url}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 items-center">
          <Progress value={progress} />
          <span className="w-12 flex justify-center">
            {progress.toFixed(0)}%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
