"use client";

import useStore from "../store";
import { VideoContext } from "../VideoContext";
import VideoProgress from "../VideoProgress";

export default function SimpleProgressList() {
  const videos = useStore((s) => s.videosDownloading);

  return (
    <ul className="flex flex-col gap-4">
      {videos.map(({ url }) => (
        <VideoContext key={url} url={url}>
          <VideoProgress />
        </VideoContext>
      ))}
    </ul>
  );
}
