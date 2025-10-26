import { HydrateClient } from "~/trpc/server";
import RealtimeVideoAdderForm from "./RealtimeVideoAdderForm";
import RealtimeProgressList from "./RealtimeProgressList";

export default function RealtimePage() {
  return (
    <HydrateClient>
      <div className="flex h-screen w-full flex-col items-center p-8">
        <main className="flex flex-col w-full max-w-xl gap-8">
          <div className="w-full">
            <h1 className="text-2xl font-bold mb-4">Realtime Downloads</h1>
            <p className="text-gray-600 mb-6">
              Old implementation with real-time progress tracking via
              EventEmitter
            </p>
          </div>
          <section className="w-full">
            <RealtimeVideoAdderForm />
          </section>
          <section>
            <RealtimeProgressList />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
