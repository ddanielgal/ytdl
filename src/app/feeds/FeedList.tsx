"use client";

import { trpc } from "~/trpc/client";
import Link from "next/link";
import { ExternalLink, Calendar, User } from "lucide-react";

export default function FeedList() {
  const { data, isLoading, error } = trpc.getYoutubeFeed.useQuery();

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
      <div className="mb-6">
        <h2 className="text-xl font-semibold mb-2">{data.channelName}</h2>
        <p className="text-sm text-muted-foreground">
          {data.items.length} video{data.items.length !== 1 ? "s" : ""} found
        </p>
      </div>

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
                <Link
                  href={item.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-primary hover:underline shrink-0"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span className="hidden sm:inline">Watch</span>
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
