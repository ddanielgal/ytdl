"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";

export default function VideoAdderForm() {
  const [url, setUrl] = useState("");
  const { mutate: addVideo, isPending } = trpc.addVideo.useMutation({
    onSuccess: () => setUrl(""),
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
    </form>
  );
}
