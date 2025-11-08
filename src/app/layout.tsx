import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "~/trpc/client";
import { AppSidebar } from "~/components/app-sidebar";
import { SidebarProvider, SidebarInset } from "~/components/ui/sidebar";
import { MobileSidebarTrigger } from "~/components/mobile-sidebar-trigger";

export const metadata: Metadata = {
  title: "ytdl",
  description: "a simple youtube video downloader for jellyfin",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <TRPCProvider>
          <SidebarProvider defaultOpen={true}>
            <AppSidebar />
            <SidebarInset>
              <header className="relative flex h-16 shrink-0 items-center gap-2 md:border-b pr-2 md:px-6">
                <div className="flex flex-1 items-center justify-end">
                  <div className="absolute top-2 right-2 md:relative md:top-0 md:right-0">
                    <MobileSidebarTrigger />
                  </div>
                </div>
              </header>
              <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 md:gap-6">
                {children}
              </div>
            </SidebarInset>
          </SidebarProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
