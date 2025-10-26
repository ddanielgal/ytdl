"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";

export default function VideoAdderForm() {
  const [url, setUrl] = useState("");
  const { mutate: addVideo, isPending } = trpc.addVideo.useMutation({
    onSuccess: ({ metadata, jobId }) => {
      // Job is now queued, we'll track it via queue status
      console.log(`Video "${metadata.title}" queued with job ID: ${jobId}`);
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
        Add Video
      </Button>
    </form>
  );
}
