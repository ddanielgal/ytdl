"use client";

import { ListVideo, Bug, X, Rss } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";
import { Button } from "./ui/button";

export function AppSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();

  const handleLinkClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <Sidebar>
      <SidebarHeader className="relative">
        <h1 className="font-semibold text-xl px-2 my-2">🦆 ytdlq</h1>
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 h-8 w-8"
            onClick={() => setOpenMobile(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close Sidebar</span>
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/"}>
                  <Link href="/" onClick={handleLinkClick}>
                    <Rss />
                    <span>Feeds</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/queue"}>
                  <Link href="/queue" onClick={handleLinkClick}>
                    <ListVideo />
                    <span>Queue</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/debug"}>
                  <Link href="/debug" onClick={handleLinkClick}>
                    <Bug />
                    <span>Debug</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
