"use client";

import { useState } from "react";
import { trpc } from "~/trpc/client";
import { addMessage } from "./actions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { useVideo } from "./VideoContext";
import { ChevronDown, ChevronUp } from "lucide-react";

export default function VideoProgress() {
  const { url, title, messages } = useVideo();
  const [isExpanded, setIsExpanded] = useState(false);

  trpc.simpleVideoProgress.useSubscription(
    { url },
    {
      onData: (data) => {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        addMessage(url, message);
      },
    }
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-2 min-w-0 flex-1 pr-2">
            <CardTitle className="text-base sm:text-lg break-words">{title}</CardTitle>
            <CardDescription className="text-xs sm:text-sm break-all">{url}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {messages.length > 0 ? (
            <div className="border rounded-md bg-muted/50 relative">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="absolute top-2 right-2 z-10 flex items-center gap-1"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4" />
                    <span className="hidden sm:inline">Collapse</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4" />
                    <span className="hidden sm:inline">Expand</span>
                  </>
                )}
              </Button>
              <div className="text-xs p-3 font-mono pr-20 sm:pr-24">
                {(isExpanded ? messages : messages.slice(-5)).map(
                  (message, index) => (
                    <div
                      key={index}
                      className={
                        isExpanded
                          ? "whitespace-pre-wrap break-words"
                          : "whitespace-nowrap overflow-hidden text-ellipsis"
                      }
                    >
                      {message}
                    </div>
                  )
                )}
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
