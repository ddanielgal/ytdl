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

    // Add new message to the beginning of the array
    video.messages.unshift(message);

    // Keep only the latest 5 messages
    if (video.messages.length > 5) {
      video.messages = video.messages.slice(0, 5);
    }
  });
}
