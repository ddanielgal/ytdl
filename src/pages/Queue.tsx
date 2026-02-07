import VideoAdderForm from "~/components/VideoAdderForm";
import JobsList from "~/components/JobsList";

export function QueuePage() {
  return (
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
  );
}
