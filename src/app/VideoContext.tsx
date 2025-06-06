import { createContext, ReactNode, useContext } from "react";
import useStore, { Video } from "./store";

const context = createContext<Video | null>(null);

export const useVideo = () => {
  const video = useContext(context);
  if (!video) {
    throw new Error("useVideo must be used within a VideoContext");
  }
  return video;
};

export function VideoContext({
  url,
  children,
}: {
  url: string;
  children: ReactNode;
}) {
  const video = useStore((s) => s.videosDownloading.find((v) => v.url === url));
  if (!video) {
    return null;
  }
  return <context.Provider value={video}>{children}</context.Provider>;
}
