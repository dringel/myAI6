"use client";

import { cn } from "@/lib/utils";
import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";

// enable inline $...$ math (plugin default only renders $$...$$ display math)
const math = createMathPlugin({ singleDollarTextMath: true });

type ResponseProps = ComponentProps<typeof Streamdown>;

// Allow all elements to render (override rehype-harden default blocking)
const allowElement = () => true;

/**
 * Sanitize response text before rendering:
 * - Remove [blocked] artifacts from empty markdown links
 * - Remove empty markdown links like [text]() that cause [blocked]
 */
function sanitizeResponseText(text: string): string {
  if (!text) return text;
  let s = text;
  // Remove markdown links with empty URLs: [text]() → text
  s = s.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
  // Remove [blocked] text
  s = s.replace(/ ?\[blocked\]/g, "");
  return s;
}

export const Response = memo(
  ({ className, children, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      plugins={{ code, math }}
      animated
      allowElement={allowElement}
      {...props}
    >
      {typeof children === "string" ? sanitizeResponseText(children) : children}
    </Streamdown>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);
