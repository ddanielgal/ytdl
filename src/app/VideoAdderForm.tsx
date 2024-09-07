"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";

export default function VideoAdderForm() {
  const [url, setUrl] = useState("");
  const { mutate: addVideo } = trpc.addVideo.useMutation({
    onSuccess: () => setUrl(""),
  });
  return (
    <form
      className="flex gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        addVideo({ url });
      }}
    >
      <input
        type="text"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <button type="submit">Add Video</button>
    </form>
  );
}
