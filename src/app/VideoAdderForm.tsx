"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";

export default function VideoAdderForm() {
  const [url, setUrl] = useState("");
  const utils = trpc.useUtils();
  const { mutate: addVideo, isPending } = trpc.addVideo.useMutation({
    onSuccess: () => {
      setUrl("");
      utils.getQueueStats.invalidate();
    },
  });
  return (
    <form
      className="w-full flex flex-col sm:flex-row gap-2 sm:gap-4"
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
        className="flex-1"
      />
      <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
        Add Video
      </Button>
    </form>
  );
}
