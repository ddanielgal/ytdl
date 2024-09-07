"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";

export default function VideoProgress({ url }: { url: string }) {
  const [progress, setProgress] = useState(0);
  trpc.videoProgress.useSubscription(
    { url },
    {
      onData: (data) => {
        console.log({ data });
      },
    }
  );
  return null;
}
