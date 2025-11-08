import { HydrateClient } from "~/trpc/server";
import SimpleVideoAdderForm from "./SimpleVideoAdderForm";
import SimpleProgressList from "./SimpleProgressList";

export default function SimplePage() {
  return (
    <HydrateClient>
      <div className="flex w-full flex-col items-center">
        <main className="flex flex-col w-full max-w-xl gap-4 md:gap-8">
          <section className="w-full">
            <SimpleVideoAdderForm />
          </section>
          <section className="w-full">
            <SimpleProgressList />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
