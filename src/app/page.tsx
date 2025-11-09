import { HydrateClient } from "~/trpc/server";
import FeedList from "./feeds/FeedList";

export default function Home() {
  return (
    <HydrateClient>
      <div className="flex w-full flex-col items-center">
        <main className="flex flex-col w-full max-w-4xl gap-4 md:gap-8">
          <section className="w-full">
            <FeedList />
          </section>
        </main>
      </div>
    </HydrateClient>
  );
}
