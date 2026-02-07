import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { trpc } from "~/trpc/client";
import { Calendar, Radio, RefreshCw, Clock } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import FeedDownloadButton from "~/components/FeedDownloadButton";

// Hardcoded channel IDs
const CHANNEL_IDS = [
  "UCsBjURrPoezykLs9EqgamOA", // Fireship
  "UCsXVk37bltHxD1rDPwtNM8Q", // Kurzgesagt
  // "UCbRP3c757lWg9M-U7TyEkXA", // t3.gg
  "UC9qpYwK7N9EB0-SECANa23g", // Jolvanezigy
  "UCAL3JXZSzSm8AlZyD3nQdBA", // Primitive Technology
  "UC3XTzVzaHQEd30rQbuvCtTQ", // Last Week Tonight
  "UCi8C7TNs2ohrc6hnRQ5Sn2w", // Kai Lentit
  "UCCgK6peZI5-FKDCWzMIFk2A", // Almost Friday TV
];

export default function FeedList() {
  const utils = trpc.useUtils();

  // Create queries for all channels
  const queries = CHANNEL_IDS.map((channelId) =>
    trpc.getYoutubeFeed.useQuery({ channelId })
  );

  // Format duration from seconds to HH:MM:SS or MM:SS
  const formatDuration = (seconds: number | undefined): string => {
    if (!seconds) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    }
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  // Combine all results
  const allItems = useMemo(() => {
    const items: Array<{
      title: string;
      videoUrl: string;
      uploadDate: string;
      channelName: string;
      channelId: string;
      queueStatus: "waiting" | "active" | "completed" | "failed" | null;
      duration?: number | undefined;
    }> = [];

    queries.forEach((query, index) => {
      if (query.data?.items) {
        const channelId = CHANNEL_IDS[index];
        items.push(
          ...query.data.items.map((item) => ({
            ...item,
            channelId,
          }))
        );
      }
    });

    // Sort by date (newest first)
    return items.sort((a, b) => {
      const dateA = new Date(a.uploadDate).getTime();
      const dateB = new Date(b.uploadDate).getTime();
      return dateB - dateA;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.data)]);

  const isFetching = queries.some((q) => q.isFetching);
  const hasError = queries.some((q) => q.error);
  const loadedChannels = queries.filter((q) => !q.isFetching).length;

  const handleRefresh = () => {
    CHANNEL_IDS.forEach((channelId) => {
      utils.getYoutubeFeed.invalidate({ channelId });
    });
  };

  if (hasError) {
    const firstError = queries.find((q) => q.error)?.error;
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-destructive">
          Error loading feeds: {firstError?.message ?? "Unknown error"}
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-sm text-muted-foreground">
            {loadedChannels}/{CHANNEL_IDS.length} channels
          </div>
          <Button
            onClick={handleRefresh}
            variant="outline"
            size="sm"
            disabled={isFetching}
          >
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline ml-2">Refresh</span>
          </Button>
        </div>
        <div className="space-y-3">
          {allItems.map((item, index) => {
            let uploadDate: Date;
            try {
              uploadDate = new Date(item.uploadDate);
            } catch {
              uploadDate = new Date();
            }

            return (
              <div key={index} className="border rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <h3 className="font-semibold text-lg mb-2 line-clamp-2 cursor-default">
                          {item.title}
                        </h3>
                      </TooltipTrigger>
                      <TooltipContent
                        className="max-w-[calc(100vw-2rem)] sm:max-w-md whitespace-normal break-words"
                        side="top"
                        align="center"
                      >
                        <p className="whitespace-normal">{item.title}</p>
                      </TooltipContent>
                    </Tooltip>
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
                      {item.duration && (
                        <div className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          <span>{formatDuration(item.duration)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <FeedDownloadButton
                    videoUrl={item.videoUrl}
                    queueStatus={item.queueStatus}
                    channelId={item.channelId}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
