"use client";

import useStore from "./store";
import { VideoContext } from "./VideoContext";
import VideoProgress from "./VideoProgress";

export default function ProgressList() {
  const videos = useStore((s) => s.videosDownloading);

  return videos.map(({ url }) => (
    <VideoContext key={url} url={url}>
      <VideoProgress />
    </VideoContext>
  ));
}
