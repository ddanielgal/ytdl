"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import { Calendar, User, Download } from "lucide-react";
import { Button } from "~/components/ui/button";

export default function FeedList() {
  const { data, isLoading, error } = trpc.getYoutubeFeed.useQuery();
  const [addingVideoUrl, setAddingVideoUrl] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { mutate: addVideo } = trpc.addVideo.useMutation({
    onSuccess: () => {
      setAddingVideoUrl(null);
      utils.getQueueStats.invalidate();
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
                      <User className="h-4 w-4" />
                      <span>{item.channelName}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      <span>
                        {uploadDate.toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  </div>
                </div>
                <Button
                  onClick={() => {
                    setAddingVideoUrl(item.videoUrl);
                    addVideo({ url: item.videoUrl });
                  }}
                  disabled={addingVideoUrl === item.videoUrl}
                  className="shrink-0"
                  variant="default"
                >
                  <Download className="h-4 w-4" />
                  <span className="hidden sm:inline ml-2">
                    {addingVideoUrl === item.videoUrl
                      ? "Adding..."
                      : "Download"}
                  </span>
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
