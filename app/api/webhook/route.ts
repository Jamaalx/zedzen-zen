import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/bot";

/**
 * POST /api/webhook
 * Whapi.Cloud webhook - receives incoming WhatsApp messages.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const messages = body.messages || [];

  for (const msg of messages) {
    if (!msg.chat_id || msg.from_me) continue;

    // Only handle private chats (not groups) for now
    if (msg.chat_id.includes("@g.us")) continue;

    // Only handle text messages
    const text = msg.text?.body;
    if (!text) continue;

    try {
      await handleMessage(msg.chat_id, text);
    } catch (err) {
      console.error("[WEBHOOK] Error handling message:", err);
    }
  }

  return NextResponse.json({ received: true });
}

export async function GET() {
  return NextResponse.json({ status: "ZEN Bot webhook active" });
}
