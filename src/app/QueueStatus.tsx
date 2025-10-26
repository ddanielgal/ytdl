"use client";

import { trpc } from "~/trpc/client";
import { Badge } from "~/components/ui/badge";

export default function QueueStatus() {
  const { data: queueStats, isLoading } = trpc.getQueueStats.useQuery();

  if (isLoading) {
    return null;
  }

  if (!queueStats) {
    return null;
  }

  if (queueStats.jobs.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <div className="space-y-2">
        {queueStats.jobs.map((job) => (
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
    </div>
  );
}
