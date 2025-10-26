"use client";

import { trpc } from "~/trpc/client";

export default function QueueStatus() {
  const { data: queueStats, isLoading } = trpc.getQueueStats.useQuery();

  if (isLoading) {
    return null;
  }

  if (!queueStats) {
    return null;
  }

  const totalJobs =
    queueStats.waiting +
    queueStats.active +
    queueStats.completed +
    queueStats.failed;

  if (totalJobs === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <h2 className="text-lg font-semibold mb-4">Queue Status</h2>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-yellow-100 p-3 rounded text-center">
          <div className="text-2xl font-bold text-yellow-800">
            {queueStats.waiting}
          </div>
          <div className="text-sm text-yellow-600">Waiting</div>
        </div>
        <div className="bg-blue-100 p-3 rounded text-center">
          <div className="text-2xl font-bold text-blue-800">
            {queueStats.active}
          </div>
          <div className="text-sm text-blue-600">Active</div>
        </div>
        <div className="bg-green-100 p-3 rounded text-center">
          <div className="text-2xl font-bold text-green-800">
            {queueStats.completed}
          </div>
          <div className="text-sm text-green-600">Completed</div>
        </div>
        <div className="bg-red-100 p-3 rounded text-center">
          <div className="text-2xl font-bold text-red-800">
            {queueStats.failed}
          </div>
          <div className="text-sm text-red-600">Failed</div>
        </div>
      </div>

      {/* Job Lists */}
      <div className="space-y-4">
        {/* Waiting Jobs */}
        {queueStats.jobs.waiting.length > 0 && (
          <div>
            <h3 className="font-medium text-yellow-800 mb-2">Waiting Jobs</h3>
            <div className="space-y-2">
              {queueStats.jobs.waiting.map((job) => (
                <div
                  key={job.id}
                  className="bg-yellow-50 p-3 rounded border border-yellow-200"
                >
                  <div className="font-medium">{job.data.title}</div>
                  <div className="text-sm text-gray-600">Job ID: {job.id}</div>
                  <div className="text-sm text-gray-500">
                    Queued: {new Date(job.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Active Jobs */}
        {queueStats.jobs.active.length > 0 && (
          <div>
            <h3 className="font-medium text-blue-800 mb-2">Active Jobs</h3>
            <div className="space-y-2">
              {queueStats.jobs.active.map((job) => (
                <div
                  key={job.id}
                  className="bg-blue-50 p-3 rounded border border-blue-200"
                >
                  <div className="font-medium">{job.data.title}</div>
                  <div className="text-sm text-gray-600">Job ID: {job.id}</div>
                  <div className="text-sm text-gray-500">
                    Started: {new Date(job.startedAt ?? 0).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed Jobs */}
        {queueStats.jobs.completed.length > 0 && (
          <div>
            <h3 className="font-medium text-green-800 mb-2">Completed Jobs</h3>
            <div className="space-y-2">
              {queueStats.jobs.completed.map((job) => (
                <div
                  key={job.id}
                  className="bg-green-50 p-3 rounded border border-green-200"
                >
                  <div className="font-medium">{job.data.title}</div>
                  <div className="text-sm text-gray-600">Job ID: {job.id}</div>
                  <div className="text-sm text-gray-500">
                    Completed: {new Date(job.completedAt ?? 0).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Failed Jobs */}
        {queueStats.jobs.failed.length > 0 && (
          <div>
            <h3 className="font-medium text-red-800 mb-2">Failed Jobs</h3>
            <div className="space-y-2">
              {queueStats.jobs.failed.map((job) => (
                <div
                  key={job.id}
                  className="bg-red-50 p-3 rounded border border-red-200"
                >
                  <div className="font-medium">{job.data.title}</div>
                  <div className="text-sm text-gray-600">Job ID: {job.id}</div>
                  <div className="text-sm text-gray-500">
                    Failed: {new Date(job.failedAt ?? 0).toLocaleString()}
                  </div>
                  {job.error && (
                    <div className="text-sm text-red-600 mt-1">
                      Error: {job.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
