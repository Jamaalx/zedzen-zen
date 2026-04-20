/**
 * ZEN Bot Core - authentication, command routing, session management.
 * This is the brain of the WhatsApp bot.
 */

import { getDb } from "./supabase";
import { sendText } from "./whapi";
import * as manager from "./manager-api";
import Anthropic from "@anthropic-ai/sdk";

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
  permissions: string[];
  is_active: boolean;
}

interface Command {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  category: string;
  handler_type: string;
  handler_config: Record<string, unknown>;
  required_role: string;
  is_active: boolean;
  sort_order: number;
}

const ROLE_HIERARCHY: Record<string, number> = { user: 0, manager: 1, admin: 2 };
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

// --- Session Management ---

async function getOrCreateSession(chatId: string): Promise<Session> {
  const db = getDb();

  // Find active session
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

  // Create new unauthenticated session
  const { data: session } = await db
    .from("zen_sessions")
    .insert({ chat_id: chatId })
    .select("*")
    .single();

  return session as Session;
}

async function authenticateSession(session: Session, user: User): Promise<void> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await db
    .from("zen_sessions")
    .update({
      user_id: user.id,
      is_authenticated: true,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  await db
    .from("zen_users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", user.id);
}

// --- Command Resolution ---

async function resolveCommand(input: string): Promise<{ command: Command | null; args: string }> {
  const db = getDb();
  const text = input.trim();
  const firstWord = text.split(/\s+/)[0].toLowerCase().replace(/^[!/]/, "");
  const args = text.slice(text.indexOf(" ") + 1).trim();

  const { data: commands } = await db
    .from("zen_commands")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (!commands) return { command: null, args: text };

  // Exact match on name
  const exact = commands.find((c: Command) => c.name === firstWord);
  if (exact) return { command: exact as Command, args: args === firstWord ? "" : args };

  // Alias match
  const aliased = commands.find((c: Command) =>
    (c.aliases || []).some((a: string) => a === firstWord)
  );
  if (aliased) return { command: aliased as Command, args: args === firstWord ? "" : args };

  // No command matched - treat as free text for AI
  return { command: null, args: text };
}

function hasPermission(user: User, command: Command): boolean {
  const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[command.required_role] ?? 0;
  return userLevel >= requiredLevel;
}

// --- Log ---

async function logCommand(
  session: Session,
  user: User | null,
  command: string,
  input: string,
  output: string,
  status: string,
  startTime: number
) {
  const db = getDb();
  await db.from("zen_logs").insert({
    session_id: session.id,
    user_id: user?.id,
    user_phone: user?.phone || session.chat_id,
    command,
    input,
    output: output.slice(0, 2000),
    status,
    execution_ms: Date.now() - startTime,
  });
}

// --- Built-in Command Handlers ---

async function handleHelp(user: User): Promise<string> {
  const db = getDb();
  const { data: commands } = await db
    .from("zen_commands")
    .select("name, description, category, required_role")
    .eq("is_active", true)
    .order("sort_order");

  if (!commands?.length) return "Nu sunt comenzi configurate.";

  const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
  const available = commands.filter(
    (c: { required_role: string }) => (ROLE_HIERARCHY[c.required_role] ?? 0) <= userLevel
  );

  const byCategory = new Map<string, Array<{ name: string; description: string }>>();
  for (const c of available) {
    const cat = (c as { category: string }).category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(c as { name: string; description: string });
  }

  const categoryEmoji: Record<string, string> = {
    system: "⚙️",
    orders: "📦",
    suppliers: "🏭",
    reports: "📊",
    admin: "🔐",
    general: "💬",
  };

  let msg = "🤖 *ZEN Bot - Comenzi disponibile*\n";
  for (const [cat, cmds] of byCategory) {
    msg += `\n${categoryEmoji[cat] || "📌"} *${cat.toUpperCase()}*\n`;
    for (const c of cmds) {
      msg += `  /${c.name} - ${c.description}\n`;
    }
  }
  msg += `\n_Rol: ${user.role} | Sesiune: 24h_`;
  return msg;
}

async function handleSystemStatus(): Promise<string> {
  const db = getDb();
  const { count: userCount } = await db.from("zen_users").select("*", { count: "exact", head: true }).eq("is_active", true);
  const { count: sessionCount } = await db.from("zen_sessions").select("*", { count: "exact", head: true }).eq("is_authenticated", true).gt("expires_at", new Date().toISOString());
  const { count: logCount } = await db.from("zen_logs").select("*", { count: "exact", head: true });

  // Check manager API
  let managerStatus = "❌ offline";
  try {
    const res = await fetch(`${process.env.MANAGER_API_URL || "https://manager.zed-zen.com"}/api/health`);
    if (res.ok) managerStatus = "✅ online";
  } catch { /* offline */ }

  return `📊 *Status ZEN Bot*

🟢 Bot: online
${managerStatus.startsWith("✅") ? "🟢" : "🔴"} Manager API: ${managerStatus}
👥 Utilizatori: ${userCount || 0}
🔑 Sesiuni active: ${sessionCount || 0}
📝 Total comenzi executate: ${logCount || 0}
🕐 ${new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}`;
}

async function handleTodayOrders(): Promise<string> {
  try {
    const data = await manager.triggerSheets();
    if (data.error) return `❌ Eroare: ${data.error}`;

    let msg = "📦 *Comenzi azi*\n\n";
    if (data.message) msg += data.message;
    if (data.orders_processed !== undefined) msg += `\nComenzi procesate: ${data.orders_processed}`;
    if (data.items_created !== undefined) msg += `\nProduse gasite: ${data.items_created}`;
    return msg || "📦 Nicio comanda noua astazi.";
  } catch (err) {
    return `❌ Eroare la verificare comenzi: ${String(err)}`;
  }
}

async function handleListSuppliers(): Promise<string> {
  try {
    const res = await fetch(`${process.env.MANAGER_API_URL || "https://manager.zed-zen.com"}/api/suppliers`, {
      headers: { Authorization: `Bearer ${process.env.MANAGER_CRON_SECRET}` },
    });
    const suppliers = await res.json();

    if (!Array.isArray(suppliers) || suppliers.length === 0) {
      return "Nu sunt furnizori in baza de date.";
    }

    let msg = "🏭 *Furnizori activi*\n\n";
    for (const s of suppliers) {
      const phone = s.phone ? `📱 ${s.phone}` : "❌ fara tel";
      const contact = s.contact_name ? `👤 ${s.contact_name}` : "";
      msg += `• *${s.name}* (${s.category})\n  ${phone} ${contact}\n`;
    }
    return msg;
  } catch {
    return "❌ Nu pot accesa lista de furnizori. Manager API offline?";
  }
}

async function handleTriggerDispatch(): Promise<string> {
  try {
    const data = await manager.triggerDispatch();
    if (data.error) return `❌ Eroare dispatch: ${data.error}`;
    return `✅ *Dispatch executat*\n${data.message || JSON.stringify(data)}`;
  } catch (err) {
    return `❌ Eroare: ${String(err)}`;
  }
}

async function handleTriggerSheets(): Promise<string> {
  try {
    const data = await manager.triggerSheets();
    if (data.error) return `❌ Eroare sheets: ${data.error}`;
    return `✅ *Sheets verificat*\n${data.message || JSON.stringify(data)}`;
  } catch (err) {
    return `❌ Eroare: ${String(err)}`;
  }
}

async function handleStartOnboarding(chatId: string): Promise<string> {
  try {
    const data = await manager.startOnboarding(chatId);
    return data.started
      ? `✅ ${data.message}`
      : `ℹ️ ${data.message}`;
  } catch (err) {
    return `❌ Eroare onboarding: ${String(err)}`;
  }
}

async function handleDailyReport(): Promise<string> {
  // Combine multiple data sources
  const [ordersResult, statusResult] = await Promise.allSettled([
    handleTodayOrders(),
    handleSystemStatus(),
  ]);

  const orders = ordersResult.status === "fulfilled" ? ordersResult.value : "❌ Eroare comenzi";
  const status = statusResult.status === "fulfilled" ? statusResult.value : "❌ Eroare status";

  return `📊 *Raport Zilnic - ${new Date().toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" })}*\n\n${orders}\n\n━━━━━━━━━━━━━━━\n\n${status}`;
}

async function handleAddUser(args: string, chatId: string): Promise<string> {
  const parts = args.split(/\s+/);
  if (parts.length < 3) {
    return "Format: /adduser [telefon] [nume] [pin] [rol]\nExemplu: /adduser 0722123456 Maria 5678 manager";
  }

  const [phone, name, pin, role] = parts;
  const cleanPhone = phone.replace(/[^0-9]/g, "").replace(/^0/, "40");
  const userRole = role && ["user", "manager", "admin"].includes(role) ? role : "user";

  const db = getDb();
  const { error } = await db.from("zen_users").insert({
    phone: cleanPhone,
    name,
    pin,
    role: userRole,
  });

  if (error) {
    if (error.code === "23505") return `❌ Utilizatorul ${phone} exista deja.`;
    return `❌ Eroare: ${error.message}`;
  }

  // Send welcome message to new user
  await sendText(cleanPhone, `🤖 Bun venit la *ZEN Bot*!\n\nAi fost adaugat de un administrator.\nPIN-ul tau este: *${pin}*\n\nTrimite PIN-ul pentru a te autentifica.`);

  return `✅ Utilizator adaugat: *${name}* (${cleanPhone}) - ${userRole}\nI-am trimis mesaj de bun venit.`;
}

async function handleViewLogs(): Promise<string> {
  const db = getDb();
  const { data: logs } = await db
    .from("zen_logs")
    .select("user_phone, command, status, execution_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (!logs?.length) return "📝 Niciun log inregistrat.";

  let msg = "📝 *Ultimele 10 actiuni*\n\n";
  for (const log of logs) {
    const time = new Date(log.created_at).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
    const icon = log.status === "success" ? "✅" : "❌";
    msg += `${icon} ${time} - /${log.command} (${log.user_phone?.slice(-4)}) ${log.execution_ms}ms\n`;
  }
  return msg;
}

async function handleConfigMenu(): Promise<string> {
  return `⚙️ *Setari sistem*

Trimite comanda dorita:
• /config ore [HH:MM] - Seteaza ora trimitere formular
• /config zile [1,2,3,4,5] - Zile active (1=Luni)
• /config sheet [ID] - Seteaza Google Sheet ID
• /config activ [on/off] - Activeaza/dezactiveaza comenzi

_Exemplu: /config ore 08:30_`;
}

async function handleToggleActive(args: string): Promise<string> {
  const activate = ["on", "da", "yes", "1", "activ"].includes(args.toLowerCase());
  const deactivate = ["off", "nu", "no", "0", "inactiv"].includes(args.toLowerCase());

  if (!activate && !deactivate) {
    return "Foloseste: /activare on sau /activare off";
  }

  // TODO: call manager API to toggle config
  return activate
    ? "✅ Sistemul de comenzi a fost *activat*."
    : "⏸ Sistemul de comenzi a fost *dezactivat*.";
}

async function handleLogout(session: Session): Promise<string> {
  const db = getDb();
  await db
    .from("zen_sessions")
    .update({ is_authenticated: false, updated_at: new Date().toISOString() })
    .eq("id", session.id);
  return "👋 Te-ai deconectat. Trimite PIN-ul pentru a te reconecta.";
}

// --- AI Query (grounded in knowledge base) ---

async function handleAiQuery(query: string): Promise<string> {
  const db = getDb();

  // Load knowledge base
  const { data: knowledge } = await db
    .from("zen_knowledge")
    .select("category, title, content")
    .eq("is_active", true);

  const knowledgeText = (knowledge || [])
    .map((k: { category: string; title: string; content: string }) => `[${k.category}] ${k.title}: ${k.content}`)
    .join("\n\n");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "❌ AI nu este configurat (lipseste ANTHROPIC_API_KEY).";

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `Esti ZEN, asistentul inteligent al restaurantului Ciorbe si Placinte. Raspunzi DOAR pe baza informatiilor de mai jos. Daca nu stii raspunsul, spune clar ca nu ai informatia. Comunici in romana, concis si profesional.

BAZA DE CUNOSTINTE:
${knowledgeText}

REGULI:
- NU inventa informatii
- Raspunde scurt si la obiect (max 3-4 propozitii)
- Daca intrebarea nu e despre business, proceduri sau furnizori, refuza politicos
- Mentioneaza sursa daca e relevant (ex: "conform procedurii de comenzi...")`,
      messages: [{ role: "user", content: query }],
    });

    const text = response.content[0];
    if (text.type === "text") return `🧠 ${text.text}`;
    return "❌ Nu am putut genera un raspuns.";
  } catch (err) {
    return `❌ Eroare AI: ${String(err)}`;
  }
}

// --- Main Message Handler ---

export async function handleMessage(chatId: string, text: string): Promise<void> {
  const startTime = Date.now();
  const db = getDb();
  const session = await getOrCreateSession(chatId);

  // --- Not authenticated: expect PIN ---
  if (!session.is_authenticated) {
    const pin = text.trim();

    // Find user by phone (extract from chat_id)
    const phone = chatId.replace("@s.whatsapp.net", "").replace("@c.us", "");

    const { data: user } = await db
      .from("zen_users")
      .select("*")
      .eq("phone", phone)
      .eq("is_active", true)
      .single();

    if (!user) {
      await sendText(chatId, "🔒 Nu ai acces la ZEN Bot. Contacteaza un administrator.");
      return;
    }

    if (user.pin !== pin) {
      await sendText(chatId, "🔑 PIN incorect. Incearca din nou.");
      return;
    }

    // Authenticate
    await authenticateSession(session, user as User);
    await sendText(chatId, `✅ Bun venit, *${user.name}*! (${user.role})\n\nScrie /help pentru lista de comenzi.`);
    await logCommand(session, user as User, "login", "", "success", "success", startTime);
    return;
  }

  // --- Authenticated ---
  const { data: user } = await db
    .from("zen_users")
    .select("*")
    .eq("id", session.user_id)
    .single();

  if (!user) {
    await sendText(chatId, "❌ Eroare sesiune. Trimite PIN-ul pentru reconectare.");
    await db.from("zen_sessions").update({ is_authenticated: false }).eq("id", session.id);
    return;
  }

  // Check for active flow (onboarding, config wizard, etc.)
  if (session.active_flow) {
    // TODO: route to flow handlers
    // For now, clear flow on any non-flow message
    await db.from("zen_sessions").update({ active_flow: null, flow_state: {} }).eq("id", session.id);
  }

  // Resolve command
  const { command, args } = await resolveCommand(text);

  // If no command matched, use AI
  if (!command) {
    const response = await handleAiQuery(text);
    await sendText(chatId, response);
    await logCommand(session, user as User, "ai_query", text, response, "success", startTime);
    return;
  }

  // Check permission
  if (!hasPermission(user as User, command)) {
    const msg = `🚫 Nu ai permisiunea pentru /${command.name}. Necesita rol: ${command.required_role}`;
    await sendText(chatId, msg);
    await logCommand(session, user as User, command.name, text, msg, "denied", startTime);
    return;
  }

  // Execute command
  let response: string;
  try {
    const handler = (command.handler_config as { handler: string }).handler;

    switch (handler) {
      case "help":
        response = await handleHelp(user as User);
        break;
      case "system_status":
        response = await handleSystemStatus();
        break;
      case "today_orders":
        response = await handleTodayOrders();
        break;
      case "list_suppliers":
        response = await handleListSuppliers();
        break;
      case "trigger_dispatch":
        response = await handleTriggerDispatch();
        break;
      case "trigger_sheets":
        response = await handleTriggerSheets();
        break;
      case "start_onboarding":
        response = await handleStartOnboarding(chatId);
        break;
      case "daily_report":
        response = await handleDailyReport();
        break;
      case "config_menu":
        response = await handleConfigMenu();
        break;
      case "toggle_active":
        response = await handleToggleActive(args);
        break;
      case "add_user":
        response = await handleAddUser(args, chatId);
        break;
      case "view_logs":
        response = await handleViewLogs();
        break;
      case "ai_query":
        response = await handleAiQuery(args);
        break;
      case "logout":
        response = await handleLogout(session);
        break;
      default:
        response = `❌ Handler necunoscut: ${handler}`;
    }
  } catch (err) {
    response = `❌ Eroare la executare: ${String(err)}`;
    await logCommand(session, user as User, command.name, text, response, "error", startTime);
    await sendText(chatId, response);
    return;
  }

  await sendText(chatId, response);
  await logCommand(session, user as User, command.name, text, response, "success", startTime);
}
