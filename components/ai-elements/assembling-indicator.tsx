"use client";

import { Shimmer } from "./shimmer";
import { useRotatingLabel } from "@/hooks/use-rotating-label";
import { pickRandomPastTense } from "@/lib/fun-labels";
import { Sparkles } from "lucide-react";
import { useState } from "react";

export function AssemblingIndicator({ isStreaming = true }: { isStreaming?: boolean }) {
  const activeLabel = useRotatingLabel("assembling", 3000);
  const [pastLabel] = useState(() => pickRandomPastTense("assembling"));

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
      <Sparkles className="size-4" />
      {isStreaming ? (
        <Shimmer duration={1}>{activeLabel}</Shimmer>
      ) : (
        <span>{pastLabel}</span>
      )}
    </div>
  );
}
