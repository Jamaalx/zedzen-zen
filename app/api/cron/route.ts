import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { sendText } from "@/lib/whapi";

/**
 * POST /api/cron - Process scheduled messages
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = process.env.API_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Get due messages
  const { data: messages } = await db
    .from("zen_scheduled_messages")
    .select("*")
    .eq("is_active", true)
    .lte("next_run_at", now)
    .limit(50);

  if (!messages?.length) {
    return NextResponse.json({ processed: 0 });
  }

  let sent = 0;
  for (const msg of messages) {
    try {
      await sendText(msg.to_chat_id, msg.message);
      sent++;

      if (msg.schedule_type === "once") {
        // One-time: deactivate
        await db.from("zen_scheduled_messages")
          .update({ is_active: false, last_run_at: now })
          .eq("id", msg.id);
      } else {
        // Recurring: calculate next run
        const nextRun = new Date();
        nextRun.setDate(nextRun.getDate() + 1);
        // Find next valid day
        const days: number[] = msg.schedule_days || [1, 2, 3, 4, 5];
        for (let i = 0; i < 7; i++) {
          const dayOfWeek = ((nextRun.getDay() + 6) % 7) + 1; // 1=Mon..7=Sun
          if (days.includes(dayOfWeek)) break;
          nextRun.setDate(nextRun.getDate() + 1);
        }
        // Set time
        const [h, m] = (msg.schedule_time || "09:00").split(":").map(Number);
        nextRun.setHours(h, m, 0, 0);

        await db.from("zen_scheduled_messages")
          .update({ last_run_at: now, next_run_at: nextRun.toISOString() })
          .eq("id", msg.id);
      }
    } catch (err) {
      console.error(`[CRON] Failed to send scheduled message ${msg.id}:`, err);
    }
  }

  return NextResponse.json({ processed: sent, total: messages.length });
}
