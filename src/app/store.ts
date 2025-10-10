import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type Video = {
  id: string;
  url: string;
  title: string;
  progress: number;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "FAILED" | "DELAYED" | "WAITING";
  error?: string;
};

type State = {
  videosDownloading: Video[];
};

const initialState: State = { videosDownloading: [] };

const useStore = create(immer(() => initialState));

export default useStore;
