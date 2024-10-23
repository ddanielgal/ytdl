import { HydrateClient } from "~/trpc/server";
import VideoAdderForm from "./VideoAdderForm";
import VideoList from "./VideoList";
import ProgressList from "./ProgressList";

export default function Home() {
  return (
    <HydrateClient>
      <div className="flex h-screen w-screen flex-col items-center p-8">
        <main className="flex flex-col w-full max-w-xl gap-8">
          <section className="w-full">
            <VideoAdderForm />
          </section>
          <section>
            <ProgressList />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
