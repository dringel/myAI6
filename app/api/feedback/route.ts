import { z } from "zod";

const feedbackSchema = z.object({
  messageId: z.string().min(1),
  rating: z.enum(["up", "down"]),
});

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = feedbackSchema.safeParse(body);
  if (!result.success) {
    return Response.json({ error: "Invalid feedback data" }, { status: 400 });
  }

  const { messageId, rating } = result.data;

  // Feedback logged server-side. Replace with database storage when ready.
  if (process.env.NODE_ENV === "development") {
    console.debug("FEEDBACK:", { messageId, rating, timestamp: new Date().toISOString() });
  }

  return Response.json({ success: true });
}
