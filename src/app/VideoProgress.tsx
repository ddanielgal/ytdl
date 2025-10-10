"use client";

import { trpc } from "~/trpc/client";
import { removeVideo, setProgress, updateVideoStatus } from "./actions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useVideo } from "./VideoContext";
import { Progress } from "~/components/ui/progress";
import { Badge } from "~/components/ui/badge";

export default function VideoProgress() {
  const { id, url, title, progress, status, error } = useVideo();

  // Subscribe to real-time progress updates
  trpc.jobProgress.useSubscription(
    { jobId: id },
    {
      onData: (data) => {
        setProgress(id, data.progress);
        updateVideoStatus(id, data.status, data.error);
      },
    }
  );

  // Subscribe to job completion
  trpc.jobFinished.useSubscription(
    { jobId: id },
    {
      onData: () => {
        // Remove completed jobs after a delay
        setTimeout(() => {
          removeVideo(id);
        }, 3000);
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
          <Badge className={getStatusColor(status)}>
            {status}
          </Badge>
        </div>
        <CardDescription className="truncate">{url}</CardDescription>
        {error && (
          <CardDescription className="text-red-600">
            Error: {error}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 items-center">
          <Progress value={progress} className="flex-1" />
          <span className="w-12 flex justify-center text-sm font-medium">
            {progress.toFixed(0)}%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
