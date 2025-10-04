"use client";

import { useEffect, useState } from "react";
import VideoProgress from "./VideoProgress";
import { trpc } from "~/trpc/client";

export default function ProgressList() {
  const [videos, setVideos] = useState<any[]>([]);

  // Load active jobs on mount for persistence
  const { data: activeJobs } = trpc.getActiveJobs.useQuery();

  useEffect(() => {
    if (activeJobs) {
      setVideos(activeJobs);
    }
  }, [activeJobs]);

  return (
    <ul className="flex flex-col gap-4">
      {videos.map((video) => (
        <VideoProgress
          key={video.id}
          id={video.id}
          url={video.url}
          title={video.title}
          progress={video.progress}
          status={video.status}
          error={video.error}
        />
      ))}
    </ul>
  );
}
