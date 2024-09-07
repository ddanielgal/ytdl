"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import VideoProgress from "./VideoProgress";

export default function VideoAdderForm() {
  const [url, setUrl] = useState("");
  const [subscription, setSubscription] = useState<string | null>(null);
  const { mutate: addVideo, isPending } = trpc.addVideo.useMutation({
    onSuccess: () => {
      setSubscription(url);
      setUrl("");
    },
  });
  return (
    <form
      className="flex gap-4"
      onSubmit={(event) => {
        if (isPending) {
          return;
        }
        event.preventDefault();
        addVideo({ url });
      }}
    >
      <input
        type="text"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        disabled={isPending}
      />
      <button type="submit" disabled={isPending}>
        Add Video
      </button>
      {subscription && (
        <VideoProgress
          onFinish={() => {
            setSubscription(null);
          }}
          url={subscription}
        />
      )}
    </form>
  );
}
