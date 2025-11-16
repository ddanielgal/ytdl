"use client";

import { Download, Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { trpc } from "~/trpc/client";

interface FeedDownloadButtonProps {
  videoUrl: string;
  queueStatus: "waiting" | "active" | "completed" | "failed" | null;
  channelId: string;
}

export default function FeedDownloadButton({
  videoUrl,
  queueStatus,
  channelId,
}: FeedDownloadButtonProps) {
  const utils = trpc.useUtils();

  const { mutate: addVideo, isPending } = trpc.addVideo.useMutation({
    onSuccess: () => {
      utils.getQueueStats.invalidate();
      // Only invalidate the specific channel's feed query
      utils.getYoutubeFeed.invalidate({ channelId });
    },
  });

  // Completed status: show "Downloaded" disabled button with checkmark
  if (queueStatus === "completed") {
    return (
      <Button disabled size="sm" className="shrink-0" variant="secondary">
        <Check className="h-4 w-4" />
        <span className="hidden sm:inline ml-2">Downloaded</span>
      </Button>
    );
  }

  // Waiting, active, or failed status: show "Downloading" disabled button
  if (
    queueStatus === "waiting" ||
    queueStatus === "active" ||
    queueStatus === "failed"
  ) {
    return (
      <Button disabled size="sm" className="shrink-0" variant="secondary">
        <Download className="h-4 w-4" />
        <span className="hidden sm:inline ml-2">Downloading</span>
      </Button>
    );
  }

  // Null status: show "Download" button (can be enqueued)
  return (
    <Button
      onClick={() => {
        addVideo({ url: videoUrl });
      }}
      disabled={isPending}
      size="sm"
      className="shrink-0"
      variant="secondary"
    >
      <Download className="h-4 w-4" />
      <span className="hidden sm:inline ml-2">
        {isPending ? "Adding..." : "Download"}
      </span>
    </Button>
  );
}
