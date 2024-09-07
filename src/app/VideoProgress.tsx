"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";

export default function VideoProgress({
  url,
  onFinish,
}: {
  url: string;
  onFinish: () => void;
}) {
  const [progress, setProgress] = useState(0);
  trpc.videoProgress.useSubscription(
    { url },
    {
      onData: (data) => {
        setProgress(data.percent);
      },
    }
  );
  trpc.videoFinished.useSubscription({ url }, { onData: onFinish });
  return progress;
}
