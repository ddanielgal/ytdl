"use client";

import { trpc } from "~/trpc/client";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { RefreshCw } from "lucide-react";

export default function JobsList() {
  const {
    data,
    isLoading,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = trpc.getQueueStats.useInfiniteQuery(
    { limit: 20 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  function handleFetchNextPage() {
    fetchNextPage();
  }

  function handleRefresh() {
    refetch();
  }

  if (isLoading) {
    return null;
  }

  const allJobs = data?.pages.flatMap((page) => page.jobs) ?? [];

  if (allJobs.length === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="w-full">
        <div className="flex justify-end items-center mb-4">
          <Button
            onClick={handleRefresh}
            variant="outline"
            size="sm"
            disabled={isRefetching}
          >
            <RefreshCw />
            Refresh
          </Button>
        </div>
        <div className="space-y-2">
          {allJobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-3 p-3 border rounded-lg"
            >
              <Badge
                variant={job.status === "failed" ? "destructive" : "secondary"}
              >
                {job.status}
              </Badge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {job.data.uploader}: {job.data.title}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {job.data.uploader}: {job.data.title}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>

        {hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              onClick={handleFetchNextPage}
              disabled={isFetchingNextPage}
              variant="outline"
            >
              {isFetchingNextPage ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
