"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import { addVideo as addDownloadingVideo } from "../actions";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";

export default function SimpleVideoAdderForm() {
  const [url, setUrl] = useState("");
  const { mutate: addVideo, isPending } = trpc.realtimeAddVideo.useMutation({
    onSuccess: ({ metadata }) => {
      addDownloadingVideo({
        url,
        title: metadata.title,
        messages: [],
      });
      setUrl("");
    },
  });
  return (
    <form
      className="w-full flex gap-4"
      onSubmit={(event) => {
        if (isPending) {
          return;
        }
        event.preventDefault();
        addVideo({ url });
      }}
    >
      <Input
        type="text"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        disabled={isPending}
      />
      <Button type="submit" disabled={isPending}>
        {isPending ? "Adding..." : "Add Video"}
      </Button>
    </form>
  );
}
