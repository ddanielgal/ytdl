import useStore, { Video } from "./store";

const set = useStore.setState;

export function addVideo(video: Video) {
  set((state) => {
    state.videosDownloading.push(video);
  });
}

export function addMessage(url: string, message: string) {
  set((state) => {
    const video = state.videosDownloading.find((v) => v.url === url);
    if (!video) {
      return;
    }

    video.messages.unshift(message);
  });
}
