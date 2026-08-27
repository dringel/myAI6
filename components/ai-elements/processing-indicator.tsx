"use client";

import { Shimmer } from "./shimmer";
import { useRotatingLabel } from "@/hooks/use-rotating-label";
import { pickRandomPastTense } from "@/lib/fun-labels";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

export function ProcessingIndicator({ isStreaming = true }: { isStreaming?: boolean }) {
  const activeLabel = useRotatingLabel("processing", 3000);
  const [pastLabel] = useState(() => pickRandomPastTense("processing"));

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
      <RefreshCw className="size-4" />
      {isStreaming ? (
        <Shimmer duration={1}>{activeLabel}</Shimmer>
      ) : (
        <span>{pastLabel}</span>
      )}
    </div>
  );
}
