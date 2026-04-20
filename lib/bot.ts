/**
 * ZEN - Autonomous WhatsApp AI Agent.
 * Uses OpenAI GPT-4o with function calling.
 * AI decides what tools to use based on conversation.
 */

import { getDb } from "./supabase";
import { sendText } from "./whapi";
import { toolSchemas, executeTool } from "./tools";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// --- Types ---

interface Session {
  id: string;
  chat_id: string;
  user_id: string | null;
  is_authenticated: boolean;
  active_flow: string | null;
  flow_state: Record<string, unknown>;
  expires_at: string | null;
}

interface User {
  id: string;
  phone: string;
  name: string;
  pin: string;
  role: string;
  is_active: boolean;
  organization_id: string | null;
  org_name?: string;
}

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_ROUNDS = 5; // prevent infinite loops

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// =============================================
// SESSION MANAGEMENT
// =============================================

async function getOrCreateSession(chatId: string): Promise<Session> {
  const db = getDb();
  const { data: existing } = await db
    .from("zen_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .eq("is_authenticated", true)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (existing) return existing as Session;

  const { data: session } = await db
    .from("zen_sessions")
    .insert({ chat_id: chatId })
    .select("*")
    .single();

  return session as Session;
}

async function authenticateSession(session: Session, user: User): Promise<void> {
  const db = getDb();
  await db
    .from("zen_sessions")
    .update({
      user_id: user.id,
      organization_id: user.organization_id,
      is_authenticated: true,
      expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);
  await db.from("zen_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
}

// =============================================
// LOGGING
// =============================================

async function logAction(session: Session, user: User, command: string, input: string, output: string, status: string, startTime: number) {
  const db = getDb();
  await db.from("zen_logs").insert({
    session_id: session.id,
    user_id: user.id,
    user_phone: user.phone,
    organization_id: user.organization_id,
    command,
    input,
    output: output.slice(0, 2000),
    status,
    execution_ms: Date.now() - startTime,
  });
}

// =============================================
// SYSTEM PROMPT
// =============================================

function buildSystemPrompt(user: User): string {
  const orgName = user.org_name || "ZED-ZEN";
  return `Esti ZEN, asistentul AI al restaurantului "${orgName}". Vorbesti in romana, esti concis si profesional.

ORGANIZATIE: ${orgName}
UTILIZATOR CURENT: ${user.name} (rol: ${user.role}, telefon: ${user.phone})

CE POTI FACE:
- Verifica si trimite comenzi catre furnizori
- Gestioneaza furnizori si datele lor
- Raspunde la intrebari despre proceduri si business (folosind knowledge base)
- Gestioneaza utilizatorii botului (doar admin)
- Gestioneaza baza de cunostinte (doar admin)
- Trimite mesaje WhatsApp
- Arata statusul sistemului si loguri

REGULI STRICTE:
- Foloseste INTOTDEAUNA tool-urile disponibile pentru a raspunde. NU inventa date.
- Pentru intrebari despre proceduri/business, cauta MAI INTAI in knowledge base cu search_knowledge.
- Daca nu gasesti informatia in knowledge base, spune clar "Nu am aceasta informatie."
- Nu executa actiuni distructive (dispatch, stergere) fara confirmare explicita.
- Raspunde scurt si la obiect. Max 4-5 propozitii.
- Formateaza cu bold (*text*) pentru informatii importante.
- Daca userul cere "help" sau "ajutor", explica ce poti face bazat pe rolul lui.
- Pentru actiuni admin (useri, knowledge), verifica ca userul are rol admin.

ROL ${user.role.toUpperCase()}:
${user.role === "admin" ? "Acces TOTAL: comenzi, furnizori, useri, knowledge, config, logs, dispatch." : ""}
${user.role === "manager" ? "Acces: comenzi, furnizori, dispatch, sheets, onboarding, rapoarte. NU poate gestiona useri sau knowledge." : ""}
${user.role === "user" ? "Acces: vizualizare comenzi, furnizori, status, rapoarte, intrebari AI. NU poate dispatch, gestiona useri sau knowledge." : ""}

Daca userul scrie "logout" sau "iesire", confirma deconectarea.`;
}

// =============================================
// AUTONOMOUS AGENT LOOP
// =============================================

async function runAgent(userMessage: string, user: User, chatId: string): Promise<string> {
  const ai = getOpenAI();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(user) },
    { role: "user", content: userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 800,
      messages,
      tools: toolSchemas,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const msg = choice.message;

    // No tool calls - AI has final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || "...";
    }

    // Add assistant message with tool calls
    messages.push(msg);

    // Execute all tool calls
    for (const toolCall of msg.tool_calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tc = toolCall as any;
      const toolName: string = tc.function?.name || tc.name || "unknown";
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(tc.function?.arguments || tc.arguments || "{}");
      } catch { /* empty args */ }

      const result = await executeTool(toolName, toolArgs, user.role, chatId, user.organization_id || undefined);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return "Am atins limita de pasi. Incearca o intrebare mai simpla.";
}

// =============================================
// MAIN MESSAGE HANDLER
// =============================================

export async function handleMessage(chatId: string, text: string): Promise<void> {
  const startTime = Date.now();
  const db = getDb();
  const session = await getOrCreateSession(chatId);

  // --- Not authenticated: expect PIN ---
  if (!session.is_authenticated) {
    const phone = chatId.replace("@s.whatsapp.net", "").replace("@c.us", "");
    const { data: user } = await db.from("zen_users")
      .select("*, org:zen_organizations(name)")
      .eq("phone", phone).eq("is_active", true).single();

    if (!user) {
      await sendText(chatId, "🔒 Nu ai acces. Contacteaza un administrator.");
      return;
    }

    if (user.pin !== text.trim()) {
      await sendText(chatId, "🔑 PIN incorect.");
      return;
    }

    const u = user as User & { org?: { name: string } };
    u.org_name = u.org?.name || "ZED-ZEN";

    await authenticateSession(session, u);
    await sendText(chatId, `✅ Bun venit, *${u.name}*! (${u.role})\n📍 ${u.org_name}\n\n🤖 Sunt ZEN, asistentul tau. Scrie orice - eu ma descurc.`);
    await logAction(session, user as User, "login", "", "ok", "success", startTime);
    return;
  }

  // --- Authenticated: run agent ---
  const { data: user } = await db.from("zen_users")
    .select("*, org:zen_organizations(name)")
    .eq("id", session.user_id).single();
  if (!user) {
    await sendText(chatId, "❌ Sesiune invalida. Trimite PIN-ul.");
    await db.from("zen_sessions").update({ is_authenticated: false }).eq("id", session.id);
    return;
  }

  // Handle logout explicitly (don't send to AI)
  if (["logout", "iesire", "exit"].includes(text.trim().toLowerCase())) {
    await db.from("zen_sessions").update({ is_authenticated: false, updated_at: new Date().toISOString() }).eq("id", session.id);
    await sendText(chatId, "👋 Deconectat. Trimite PIN-ul pentru reconectare.");
    await logAction(session, user as User, "logout", "", "ok", "success", startTime);
    return;
  }

  // Run autonomous agent
  let response: string;
  let status = "success";
  try {
    response = await runAgent(text, user as User, chatId);
  } catch (err) {
    response = `❌ Eroare: ${String(err)}`;
    status = "error";
  }

  await sendText(chatId, response);
  await logAction(session, user as User, "agent", text, response, status, startTime);
}
