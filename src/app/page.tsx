import { HydrateClient } from "~/trpc/server";
import VideoAdderForm from "./VideoAdderForm";
import VideoList from "./VideoList";
import QueueStatus from "./QueueStatus";
import Link from "next/link";

export default function Home() {
  return (
    <HydrateClient>
      <div className="flex h-screen w-screen flex-col items-center p-8">
        <main className="flex flex-col w-full max-w-xl gap-8">
          <div className="w-full">
            <h1 className="text-2xl font-bold mb-4">YouTube Downloader</h1>
            <div className="flex gap-4 mb-6">
              <Link
                href="/"
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                Queue System
              </Link>
              <Link
                href="/realtime"
                className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
              >
                Realtime (Old)
              </Link>
            </div>
          </div>
          <section className="w-full">
            <VideoAdderForm />
          </section>
          <section>
            <QueueStatus />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
