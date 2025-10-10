import useStore, { Video } from "./store";

const set = useStore.setState;

export function addVideo(video: Video) {
  set((state) => {
    // Check if video already exists
    const existingIndex = state.videosDownloading.findIndex(
      (v) => v.id === video.id
    );
    if (existingIndex !== -1) {
      // Update existing video
      state.videosDownloading[existingIndex] = video;
    } else {
      // Add new video
      state.videosDownloading.push(video);
    }
  });
}

export function removeVideo(id: string) {
  set((state) => {
    const index = state.videosDownloading.findIndex(
      (video) => video.id === id
    );
    if (index === -1) {
      return;
    }
    state.videosDownloading.splice(index, 1);
  });
}

export function setProgress(id: string, progress: number) {
  set((state) => {
    const video = state.videosDownloading.find((v) => v.id === id);
    if (!video) {
      return;
    }
    video.progress = progress;
  });
}

export function updateVideoStatus(id: string, status: Video["status"], error?: string) {
  set((state) => {
    const video = state.videosDownloading.find((v) => v.id === id);
    if (!video) {
      return;
    }
    video.status = status;
    if (error) {
      video.error = error;
    }
  });
}

export function loadActiveJobs(jobs: Video[]) {
  set((state) => {
    state.videosDownloading = jobs;
  });
}
