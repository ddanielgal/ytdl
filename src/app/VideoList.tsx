"use client";

import { trpc } from "~/trpc/client";

export default function VideoList() {
  const { data } = trpc.listVideos.useQuery();

  return (
    <section>
      <ul className="flex flex-col gap-2">
        {data?.map((folder) => (
          <li key={folder.name}>{folder.name}</li>
        ))}
      </ul>
    </section>
  );
}
