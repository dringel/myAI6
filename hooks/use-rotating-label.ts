"use client";

import { useState, useEffect, useRef } from "react";
import { pickRandom, type FunLabelCategory } from "@/lib/fun-labels";

/**
 * Returns a label that rotates through fun words from the given category.
 * Changes every `intervalMs` milliseconds while active.
 */
export function useRotatingLabel(
  category: FunLabelCategory,
  intervalMs = 3000
): string {
  const [label, setLabel] = useState(() => pickRandom(category));
  const labelRef = useRef(label);

  useEffect(() => {
    // Pick a fresh initial label on mount
    const initial = pickRandom(category);
    setLabel(initial);
    labelRef.current = initial;

    const timer = setInterval(() => {
      const next = pickRandom(category, labelRef.current);
      setLabel(next);
      labelRef.current = next;
    }, intervalMs);

    return () => clearInterval(timer);
  }, [category, intervalMs]);

  return label;
}
