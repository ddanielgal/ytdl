"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
// Remove VideoContext dependency
import { Progress } from "~/components/ui/progress";
import { Badge } from "~/components/ui/badge";

interface VideoProgressProps {
  id: string;
  url: string;
  title: string;
  progress: number;
  status: string;
  error?: string;
}

export default function VideoProgress({ id, url, title, progress, status, error }: VideoProgressProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [currentProgress, setCurrentProgress] = useState(progress);
  const [currentStatus, setCurrentStatus] = useState(status);
  const [currentError, setCurrentError] = useState(error);

  // Subscribe to real-time progress updates
  trpc.jobProgress.useSubscription(
    { jobId: id },
    {
      onData: (data) => {
        setCurrentProgress(data.progress);
        setCurrentStatus(data.status);
        if (data.error) setCurrentError(data.error);
      },
    }
  );

  // Subscribe to real-time logs
  trpc.jobLogs.useSubscription(
    { jobId: id },
    {
      onData: (data) => {
        setLogs(prev => [...prev, data.line]);
      },
    }
  );

  // Subscribe to job completion
  trpc.jobFinished.useSubscription(
    { jobId: id },
    {
      onData: (data) => {
        // Update status to completed/failed but keep in UI
        setCurrentStatus(data.status);
        if (data.error) setCurrentError(data.error);
      },
    }
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case "PENDING":
        return "bg-yellow-100 text-yellow-800";
      case "ACTIVE":
        return "bg-blue-100 text-blue-800";
      case "COMPLETED":
        return "bg-green-100 text-green-800";
      case "FAILED":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="truncate">{title}</CardTitle>
          <Badge className={getStatusColor(currentStatus)}>
            {currentStatus}
          </Badge>
        </div>
        <CardDescription className="truncate">{url}</CardDescription>
        {currentError && (
          <CardDescription className="text-red-600">
            Error: {currentError}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 items-center">
          <Progress value={currentProgress} className="flex-1" />
          <span className="w-12 flex justify-center text-sm font-medium">
            {(currentProgress || 0).toFixed(0)}%
          </span>
        </div>

        {logs.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-sm font-medium text-gray-700">yt-dlp Output:</div>
            <div className="bg-gray-100 p-3 rounded text-xs font-mono max-h-32 overflow-y-auto">
              {logs.map((log, index) => (
                <div key={index} className="text-gray-700">
                  {log}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
