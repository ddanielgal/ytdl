"use client";

import { trpc } from "~/trpc/client";
import { addMessage } from "./actions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useVideo } from "./VideoContext";

export default function VideoProgress() {
  const { url, title, messages } = useVideo();

  // Subscribe to video progress messages
  trpc.videoProgress.useSubscription(
    { url },
    {
      onData: (data) => {
        // Convert the data to a string message
        const message = typeof data === 'string' ? data : JSON.stringify(data);
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
          <h4 className="text-sm font-medium">Latest Messages:</h4>
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet...</p>
          ) : (
            <div className="space-y-1">
              {messages.map((message, index) => (
                <div
                  key={index}
                  className="text-xs p-2 bg-muted rounded border-l-2 border-blue-500"
                >
                  {message}
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
