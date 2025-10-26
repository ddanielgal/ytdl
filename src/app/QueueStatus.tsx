"use client";

import { trpc } from "~/trpc/client";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

export default function QueueStatus() {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.getQueueStats.useInfiniteQuery(
      { limit: 20 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  function handleFetchNextPage() {
    fetchNextPage();
  }

  if (isLoading) {
    return null;
  }

  const allJobs = data?.pages.flatMap((page) => page.jobs) ?? [];

  if (allJobs.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <div className="space-y-2">
        {allJobs.map((job) => (
          <div
            key={job.id}
            className="flex items-center justify-between p-3 border rounded-lg"
          >
            <div className="flex-1">
              <div className="font-medium">{job.data.title}</div>
            </div>
            <Badge variant="secondary">{job.status}</Badge>
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
  );
}
