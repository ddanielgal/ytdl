import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TRPCProvider } from "~/trpc/client";
import { AppSidebar } from "~/components/app-sidebar";
import { SidebarProvider, SidebarInset } from "~/components/ui/sidebar";
import { MobileSidebarTrigger } from "~/components/mobile-sidebar-trigger";
import { HomePage } from "~/pages/Home";
import { QueuePage } from "~/pages/Queue";
import { FeedsPage } from "~/pages/Feeds";

export function App() {
  return (
    <TRPCProvider>
      <BrowserRouter basename="/ytdl">
        <SidebarProvider defaultOpen={true}>
          <AppSidebar />
          <SidebarInset>
            <header className="relative flex h-16 shrink-0 items-center gap-2 pr-2 md:px-6">
              <div className="flex flex-1 items-center justify-end">
                <div className="absolute top-2 right-2 md:relative md:top-0 md:right-0">
                  <MobileSidebarTrigger />
                </div>
              </div>
            </header>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 md:gap-6">
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/queue" element={<QueuePage />} />
                <Route path="/feeds" element={<FeedsPage />} />
              </Routes>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </BrowserRouter>
    </TRPCProvider>
  );
}
