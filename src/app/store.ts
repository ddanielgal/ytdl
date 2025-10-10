import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type Video = {
  id: string;
  url: string;
  title: string;
  progress: number;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "FAILED" | "DELAYED" | "WAITING";
  error?: string;
  steps?: {
    info: { status: "pending" | "active" | "completed" | "failed"; progress: number };
    download: { status: "pending" | "active" | "completed" | "failed"; progress: number };
    remux: { status: "pending" | "active" | "completed" | "failed"; progress: number };
    subtitles: { status: "pending" | "active" | "completed" | "failed"; progress: number };
  };
};

type State = {
  videosDownloading: Video[];
};

const initialState: State = { videosDownloading: [] };

const useStore = create(immer(() => initialState));

export default useStore;
