/**
 * Whapi.Cloud API wrapper for ZEN bot.
 */

const BASE = process.env.WHAPI_BASE_URL || "https://gate.whapi.cloud";
const TOKEN = process.env.WHAPI_TOKEN || "";

export function phoneToChat(phone: string): string {
  if (phone.includes("@")) return phone;
  const clean = phone.replace(/[^0-9]/g, "").replace(/^0/, "40");
  return clean + "@s.whatsapp.net";
}

export async function sendText(to: string, body: string): Promise<{ id?: string; error?: string }> {
  const chatId = phoneToChat(to);
  try {
    const res = await fetch(`${BASE}/messages/text`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: chatId, body }),
    });
    const data = await res.json();
    if (data.message?.id) return { id: data.message.id };
    return { error: data.error?.message || "Unknown error" };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function getChats(query?: string): Promise<Array<{ id: string; name: string; type: string }>> {
  const res = await fetch(`${BASE}/chats?count=100`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const data = await res.json();
  return (data.chats || [])
    .filter((c: { id: string }) => c.id !== "status@broadcast")
    .filter((c: { name?: string; id: string }) =>
      !query || (c.name || "").toLowerCase().includes(query.toLowerCase()) || c.id.includes(query)
    )
    .map((c: { id: string; name?: string; type?: string }) => ({
      id: c.id,
      name: c.name || c.id,
      type: c.type || "unknown",
    }));
}
