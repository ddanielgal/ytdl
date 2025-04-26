import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "~/trpc/client";

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
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
