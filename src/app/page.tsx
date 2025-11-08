import { HydrateClient } from "~/trpc/server";
import VideoAdderForm from "./VideoAdderForm";
import JobsList from "./JobsList";

export default function Home() {
  return (
    <HydrateClient>
      <div className="flex w-full flex-col items-center">
        <main className="flex flex-col w-full max-w-xl gap-4 md:gap-8">
          <section className="w-full">
            <VideoAdderForm />
          </section>
          <section className="w-full">
            <JobsList />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
