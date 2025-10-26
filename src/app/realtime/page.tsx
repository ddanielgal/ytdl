import { HydrateClient } from "~/trpc/server";
import RealtimeVideoAdderForm from "./RealtimeVideoAdderForm";
import RealtimeProgressList from "./RealtimeProgressList";

export default function RealtimePage() {
  return (
    <HydrateClient>
      <div className="flex h-screen w-full flex-col items-center p-8">
        <main className="flex flex-col w-full max-w-xl gap-8">
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
