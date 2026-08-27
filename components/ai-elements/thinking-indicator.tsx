"use client";

import Image from "next/image";
import { motion } from "motion/react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useRotatingLabel } from "@/hooks/use-rotating-label";
import { Pipette } from "lucide-react";
import type { FunLabelCategory } from "@/lib/fun-labels";

/**
 * Shows the pulsing logo + a fun rotating label with shimmer.
 * Used during the "submitted" phase (waiting for first response from model).
 * When isCompacting=true, shows compaction-specific labels with an archive icon.
 */
export function ThinkingIndicator({ isCompacting = false }: { isCompacting?: boolean }) {
  const category: FunLabelCategory = isCompacting ? "compacting" : "thinking";
  const label = useRotatingLabel(category, 3000);

  return (
    <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
      {isCompacting ? (
        <Pipette className="size-4" />
      ) : (
        <motion.div
          className="relative flex-shrink-0"
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ scale: { duration: 2, repeat: Infinity, ease: "easeInOut" } }}
        >
          <motion.div
            className="absolute inset-0 rounded-full bg-muted-foreground/15 blur-md"
            animate={{ opacity: [0.2, 0.5, 0.2] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <Image src="/thinking.png" alt="" width={20} height={20} className="relative" />
        </motion.div>
      )}

      <Shimmer className="text-sm" duration={1}>
        {label}
      </Shimmer>
    </div>
  );
}
