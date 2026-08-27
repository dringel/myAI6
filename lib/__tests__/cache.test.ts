import { describe, it, expect, vi } from "vitest";
import { TTLCache } from "@/lib/cache";

describe("TTLCache", () => {
  it("stores and retrieves values", () => {
    const cache = new TTLCache<string>(60_000);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("returns undefined for missing keys", () => {
    const cache = new TTLCache<string>(60_000);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new TTLCache<string>(100); // 100ms TTL
    cache.set("key1", "value1");

    // Advance time
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);

    expect(cache.get("key1")).toBeUndefined();

    vi.useRealTimers();
  });

  it("overwrites existing values", () => {
    const cache = new TTLCache<string>(60_000);
    cache.set("key1", "value1");
    cache.set("key1", "value2");
    expect(cache.get("key1")).toBe("value2");
  });
});
