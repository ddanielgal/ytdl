"use client";

import { Download, Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { trpc } from "~/trpc/client";

interface FeedDownloadButtonProps {
  videoUrl: string;
  queueStatus: "waiting" | "active" | "completed" | "failed" | null;
  channelId: string;
}

// Normalize YouTube URL for comparison (same logic as in router)
function normalizeYoutubeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const videoId = urlObj.searchParams.get("v");
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    return url;
  }
}

export default function FeedDownloadButton({
  videoUrl,
  queueStatus,
  channelId,
}: FeedDownloadButtonProps) {
  const utils = trpc.useUtils();

  const { mutate: addVideo, isPending } = trpc.addVideo.useMutation({
    onMutate: async () => {
      // Cancel any outgoing refetches
      await utils.getYoutubeFeed.cancel({ channelId });

      // Snapshot the previous value
      const previousData = utils.getYoutubeFeed.getData({ channelId });

      // Optimistically update the cache
      utils.getYoutubeFeed.setData({ channelId }, (old) => {
        if (!old) return old;

        const normalizedVideoUrl = normalizeYoutubeUrl(videoUrl);
        return {
          ...old,
          items: old.items.map((item) => {
            const normalizedItemUrl = normalizeYoutubeUrl(item.videoUrl);
            if (normalizedItemUrl === normalizedVideoUrl) {
              return {
                ...item,
                queueStatus: "waiting" as const,
              };
            }
            return item;
          }),
        };
      });

      // Return context with the previous value
      return { previousData };
    },
    onError: (err, variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousData) {
        utils.getYoutubeFeed.setData({ channelId }, context.previousData);
      }
    },
    onSuccess: () => {
      utils.getQueueStats.invalidate();
      // Invalidate to get the real status from the queue
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
