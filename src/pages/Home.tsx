import FeedList from "~/components/FeedList";

export function HomePage() {
  return (
    <div className="flex w-full flex-col items-center">
      <main className="flex flex-col w-full max-w-4xl gap-4 md:gap-8">
        <section className="w-full">
          <FeedList />
        </section>
      </main>
    </div>
  );
}
