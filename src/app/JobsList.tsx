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
import {
  RefreshCw,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

export default function JobsList() {
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());

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

  const utils = trpc.useUtils();

  const retryJobMutation = trpc.addVideo.useMutation({
    onSuccess: () => {
      utils.getQueueStats.invalidate();
    },
  });

  const deleteJobMutation = trpc.deleteFailedJob.useMutation({
    onSuccess: () => {
      utils.getQueueStats.invalidate();
    },
  });

  function handleFetchNextPage() {
    fetchNextPage();
  }

  function handleRefresh() {
    refetch();
  }

  function toggleJobExpansion(jobId: string) {
    setExpandedJobs((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(jobId)) {
        newSet.delete(jobId);
      } else {
        newSet.add(jobId);
      }
      return newSet;
    });
  }

  function handleRetryJob(rawJob: unknown) {
    const jobParseResult = z
      .object({ data: z.object({ url: z.string() }) })
      .safeParse(rawJob);
    if (!jobParseResult.success) {
      console.error("Job does not have a URL", rawJob);
      return;
    }
    const job = jobParseResult.data;
    retryJobMutation.mutate({ url: job.data.url });
  }

  function handleDeleteJob(rawJob: unknown) {
    const jobParseResult = z.object({ id: z.string() }).safeParse(rawJob);
    if (!jobParseResult.success) {
      console.error("Job does not have an ID", rawJob);
      return;
    }
    const job = jobParseResult.data;
    deleteJobMutation.mutate({ jobId: job.id });
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
          {allJobs.map((job) => {
            const isExpanded = expandedJobs.has(job.id);
            const isFailed = job.status === "failed";

            return (
              <div key={job.id} className="border rounded-lg">
                <div className="flex items-center gap-3 p-3">
                  <Badge variant={isFailed ? "destructive" : "secondary"}>
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
                  {isFailed && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => toggleJobExpansion(job.id)}
                        className="flex items-center gap-1"
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className="h-4 w-4" />
                            Close
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-4 w-4" />
                            Details
                          </>
                        )}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRetryJob(job)}
                        disabled={retryJobMutation.isPending}
                        className="flex items-center gap-1"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Retry
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleDeleteJob(job)}
                        disabled={deleteJobMutation.isPending}
                        className="flex items-center gap-1"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                {isFailed && isExpanded && (
                  <div className="px-3 pb-3">
                    <pre className="bg-gray-100 dark:bg-gray-800 p-3 rounded text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                      {job.failedReason}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
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
