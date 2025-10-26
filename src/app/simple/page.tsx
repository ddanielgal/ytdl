import { HydrateClient } from "~/trpc/server";
import SimpleVideoAdderForm from "./SimpleVideoAdderForm";
import SimpleProgressList from "./SimpleProgressList";

export default function SimplePage() {
  return (
    <HydrateClient>
      <div className="flex h-screen w-full flex-col items-center p-8">
        <main className="flex flex-col w-full max-w-xl gap-8">
          <section className="w-full">
            <SimpleVideoAdderForm />
          </section>
          <section>
            <SimpleProgressList />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
