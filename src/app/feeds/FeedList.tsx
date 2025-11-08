"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { trpc } from "~/trpc/client";
import { Calendar, Radio, Download, Check } from "lucide-react";
import { Button } from "~/components/ui/button";

export default function FeedList() {
  const { data, isLoading, error } = trpc.getYoutubeFeed.useQuery();
  const [addingVideoUrl, setAddingVideoUrl] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { mutate: addVideo } = trpc.addVideo.useMutation({
    onSuccess: () => {
      setAddingVideoUrl(null);
      utils.getQueueStats.invalidate();
      utils.getYoutubeFeed.invalidate();
    },
    onError: () => {
      setAddingVideoUrl(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-muted-foreground">Loading feed...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-destructive">
          Error loading feed: {error.message}
        </div>
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-muted-foreground">No feed items found.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {data.items.map((item, index) => {
          let uploadDate: Date;
          try {
            uploadDate = new Date(item.uploadDate);
          } catch {
            uploadDate = new Date();
          }

          return (
            <div
              key={index}
              className="border rounded-lg p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-lg mb-2 line-clamp-2">
                    {item.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Radio className="h-4 w-4" />
                      <span>{item.channelName}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      <span>
                        {formatDistanceToNow(uploadDate, { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
                {(() => {
                  const queueStatus = item.queueStatus;
                  const isAdding = addingVideoUrl === item.videoUrl;

                  // Completed status: show "Downloaded" disabled button with checkmark
                  if (queueStatus === "completed") {
                    return (
                      <Button
                        disabled
                        size="sm"
                        className="shrink-0"
                        variant="secondary"
                      >
                        <Check className="h-4 w-4" />
                        <span className="hidden sm:inline ml-2">
                          Downloaded
                        </span>
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
                      <Button
                        disabled
                        size="sm"
                        className="shrink-0"
                        variant="secondary"
                      >
                        <Download className="h-4 w-4" />
                        <span className="hidden sm:inline ml-2">
                          Downloading
                        </span>
                      </Button>
                    );
                  }

                  // Null status: show "Download" button (can be enqueued)
                  return (
                    <Button
                      onClick={() => {
                        setAddingVideoUrl(item.videoUrl);
                        addVideo({ url: item.videoUrl });
                      }}
                      disabled={isAdding}
                      size="sm"
                      className="shrink-0"
                      variant="secondary"
                    >
                      <Download className="h-4 w-4" />
                      <span className="hidden sm:inline ml-2">
                        {isAdding ? "Adding..." : "Download"}
                      </span>
                    </Button>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
