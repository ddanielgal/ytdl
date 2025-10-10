import useStore, { Video } from "./store";

const set = useStore.setState;

export function addVideo(video: Video) {
  set((state) => {
    state.videosDownloading.push(video);
  });
}

export function removeVideo(url: string) {
  set((state) => {
    const index = state.videosDownloading.findIndex(
      (video) => video.url === url
    );
    if (index === -1) {
      return;
    }
    state.videosDownloading.splice(index, 1);
  });
}

export function setProgress(url: string, progress: number) {
  set((state) => {
    const video = state.videosDownloading.find((v) => v.url === url);
    if (!video) {
      return;
    }
    video.progress = progress;
  });
}
