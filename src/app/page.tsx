import { HydrateClient } from "~/trpc/server";
import VideoAdderForm from "./VideoAdderForm";
import VideoList from "./VideoList";
import QueueStatus from "./QueueStatus";

export default function Home() {
  return (
    <HydrateClient>
      <div className="flex h-screen w-full flex-col items-center p-8">
        <main className="flex flex-col w-full max-w-xl gap-8">
          <div className="w-full">
            <h1 className="text-2xl font-bold mb-4">YouTube Downloader</h1>
            <p className="text-gray-600 mb-6">
              Queue-based download system with progress tracking
            </p>
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
