import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/bot";
import { sendText } from "@/lib/whapi";

/**
 * POST /api/trigger
 * Trigger bot actions programmatically (from MCP, cron, etc.)
 * Auth: API_SECRET header
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = process.env.API_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action, chat_id, message } = body;

  if (!action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }

  switch (action) {
    case "send_message": {
      if (!chat_id || !message) {
        return NextResponse.json({ error: "chat_id and message required" }, { status: 400 });
      }
      const result = await sendText(chat_id, message);
      return NextResponse.json(result);
    }
    case "simulate_command": {
      if (!chat_id || !message) {
        return NextResponse.json({ error: "chat_id and message required" }, { status: 400 });
      }
      await handleMessage(chat_id, message);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
