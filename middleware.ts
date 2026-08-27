import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from "@/config";

/**
 * In-memory sliding window rate limiter.
 * Tracks request timestamps per IP. Cleans up expired entries periodically.
 */
const ipRequestLog = new Map<string, number[]>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

function cleanupExpired() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of ipRequestLog.entries()) {
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) ipRequestLog.delete(ip);
    else ipRequestLog.set(ip, valid);
  }
}

function isRateLimited(ip: string): boolean {
  if (!RATE_LIMIT_ENABLED) return false;

  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = ipRequestLog.get(ip) || [];
  const recent = timestamps.filter((t) => t > cutoff);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) return true;

  recent.push(now);
  ipRequestLog.set(ip, recent);
  cleanupExpired();
  return false;
}

function getClientIP(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function middleware(request: NextRequest) {
  // Only rate-limit the chat API endpoint
  if (!request.nextUrl.pathname.startsWith("/api/chat")) {
    return NextResponse.next();
  }

  // Check rate limit
  const ip = getClientIP(request);
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment before trying again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) } }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/chat",
};
