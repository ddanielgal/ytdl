import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "~/trpc/client";
import { AppSidebar } from "~/components/app-sidebar";
import { SidebarProvider } from "~/components/ui/sidebar";

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
            <main className="flex-1">{children}</main>
          </SidebarProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
