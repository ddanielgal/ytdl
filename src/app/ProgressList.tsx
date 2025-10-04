"use client";

import { useEffect } from "react";
import useStore from "./store";
import { VideoContext } from "./VideoContext";
import VideoProgress from "./VideoProgress";
import { trpc } from "~/trpc/client";
import { loadActiveJobs } from "./actions";

export default function ProgressList() {
  const videos = useStore((s) => s.videosDownloading);

  // Load active jobs on mount for persistence
  const { data: activeJobs } = trpc.getActiveJobs.useQuery();

  useEffect(() => {
    if (activeJobs) {
      // Only load active jobs, don't overwrite completed ones in local state
      const currentVideos = useStore.getState().videosDownloading;
      const completedJobs = currentVideos.filter(v => v.status === "COMPLETED" || v.status === "FAILED");
      loadActiveJobs([...activeJobs, ...completedJobs]);
    }
  }, [activeJobs]);

  return (
    <ul className="flex flex-col gap-4">
      {videos.map(({ id }) => (
        <VideoContext key={id} jobId={id}>
          <VideoProgress />
        </VideoContext>
      ))}
    </ul>
  );
}
