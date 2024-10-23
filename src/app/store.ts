import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type Video = {
  url: string;
  title: string;
  progress: number;
};

type State = {
  videosDownloading: Video[];
};

const initialState: State = { videosDownloading: [] };

const useStore = create(immer(() => initialState));

export default useStore;
