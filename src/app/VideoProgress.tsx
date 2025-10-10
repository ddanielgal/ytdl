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

  trpc.videoProgress.useSubscription(
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
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{url}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {messages.length > 0 ? (
            <div className="border rounded-md bg-muted/50 relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="absolute top-2 right-2 z-10 flex items-center gap-1"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4" />
                    Collapse
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4" />
                    Expand
                  </>
                )}
              </Button>
              <pre className="text-xs p-3 overflow-x-auto whitespace-pre-wrap font-mono">
                {(isExpanded ? messages : messages.slice(-5)).join("\n")}
              </pre>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
