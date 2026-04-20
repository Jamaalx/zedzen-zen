/**
 * ZEN Bot Core - full self-service WhatsApp agent.
 * Auth, commands, AI (GPT-4o), knowledge mgmt, user mgmt - all from WhatsApp.
 */

import { getDb } from "./supabase";
import { sendText } from "./whapi";
import * as manager from "./manager-api";
import OpenAI from "openai";

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
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

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
      is_authenticated: true,
      expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  await db.from("zen_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
}

// =============================================
// COMMAND RESOLUTION
// =============================================

async function resolveCommand(input: string): Promise<{ command: Command | null; args: string }> {
  const db = getDb();
  const text = input.trim();
  const firstWord = text.split(/\s+/)[0].toLowerCase().replace(/^[!/]/, "");
  const rest = text.includes(" ") ? text.slice(text.indexOf(" ") + 1).trim() : "";

  const { data: commands } = await db
    .from("zen_commands")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (!commands) return { command: null, args: text };

  const match = commands.find(
    (c: Command) => c.name === firstWord || (c.aliases || []).includes(firstWord)
  );

  if (match) return { command: match as Command, args: rest };
  return { command: null, args: text };
}

function hasPermission(user: User, command: Command): boolean {
  return (ROLE_HIERARCHY[user.role] ?? 0) >= (ROLE_HIERARCHY[command.required_role] ?? 0);
}

// =============================================
// LOGGING
// =============================================

async function log(session: Session, user: User | null, command: string, input: string, output: string, status: string, startTime: number) {
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

// =============================================
// COMMAND HANDLERS
// =============================================

async function handleHelp(user: User): Promise<string> {
  const db = getDb();
  const { data: commands } = await db.from("zen_commands").select("*").eq("is_active", true).order("sort_order");
  if (!commands?.length) return "Nu sunt comenzi configurate.";

  const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
  const available = commands.filter((c: Command) => (ROLE_HIERARCHY[c.required_role] ?? 0) <= userLevel);

  const cats = new Map<string, Command[]>();
  for (const c of available) {
    const cat = (c as Command).category;
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat)!.push(c as Command);
  }

  const emoji: Record<string, string> = { system: "⚙️", orders: "📦", suppliers: "🏭", reports: "📊", admin: "🔐", general: "💬", knowledge: "📚", users: "👥" };

  let msg = "🤖 *ZEN Bot - Comenzi*\n";
  for (const [cat, cmds] of cats) {
    msg += `\n${emoji[cat] || "📌"} *${cat.toUpperCase()}*\n`;
    for (const c of cmds) msg += `  /${c.name} - ${c.description}\n`;
  }
  msg += `\nSau scrie orice intrebare si AI-ul raspunde.\n_Rol: ${user.role} | Sesiune: 24h_`;
  return msg;
}

async function handleStatus(): Promise<string> {
  const db = getDb();
  const [users, sessions, logs, knowledge] = await Promise.all([
    db.from("zen_users").select("*", { count: "exact", head: true }).eq("is_active", true),
    db.from("zen_sessions").select("*", { count: "exact", head: true }).eq("is_authenticated", true).gt("expires_at", new Date().toISOString()),
    db.from("zen_logs").select("*", { count: "exact", head: true }),
    db.from("zen_knowledge").select("*", { count: "exact", head: true }).eq("is_active", true),
  ]);

  let managerOk = false;
  try {
    const res = await fetch(`${process.env.MANAGER_API_URL}/api/health`);
    managerOk = res.ok;
  } catch { /* */ }

  return `📊 *Status ZEN Bot*

🟢 Bot: online
${managerOk ? "🟢" : "🔴"} Manager API: ${managerOk ? "online" : "offline"}
👥 Utilizatori: ${users.count || 0}
🔑 Sesiuni active: ${sessions.count || 0}
📝 Comenzi executate: ${logs.count || 0}
📚 Knowledge base: ${knowledge.count || 0} articole
🕐 ${new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}`;
}

async function handleOrders(): Promise<string> {
  try {
    const data = await manager.triggerSheets();
    if (data.error) return `❌ ${data.error}`;
    let msg = "📦 *Comenzi azi*\n\n";
    if (data.message) msg += data.message;
    if (data.orders_processed !== undefined) msg += `\nProcesate: ${data.orders_processed}`;
    if (data.items_created !== undefined) msg += `\nProduse: ${data.items_created}`;
    return msg;
  } catch (err) {
    return `❌ ${err}`;
  }
}

async function handleSuppliers(): Promise<string> {
  try {
    const res = await fetch(`${process.env.MANAGER_API_URL}/api/suppliers`, {
      headers: { Authorization: `Bearer ${process.env.MANAGER_CRON_SECRET}` },
    });
    const suppliers = await res.json();
    if (!Array.isArray(suppliers) || !suppliers.length) return "Niciun furnizor.";

    let msg = "🏭 *Furnizori*\n\n";
    for (const s of suppliers) {
      const p = s.phone ? `📱${s.phone}` : "❌ fara tel";
      const c = s.contact_name ? ` 👤${s.contact_name}` : "";
      msg += `• *${s.name}* (${s.category}) ${p}${c}\n`;
    }
    return msg;
  } catch {
    return "❌ Manager API offline.";
  }
}

async function handleDispatch(): Promise<string> {
  try {
    const data = await manager.triggerDispatch();
    return data.error ? `❌ ${data.error}` : `✅ *Dispatch executat*\n${data.message || JSON.stringify(data)}`;
  } catch (err) {
    return `❌ ${err}`;
  }
}

async function handleSheets(): Promise<string> {
  try {
    const data = await manager.triggerSheets();
    return data.error ? `❌ ${data.error}` : `✅ *Sheets verificat*\n${data.message || JSON.stringify(data)}`;
  } catch (err) {
    return `❌ ${err}`;
  }
}

async function handleOnboarding(chatId: string): Promise<string> {
  try {
    const data = await manager.startOnboarding(chatId);
    return data.started ? `✅ ${data.message}` : `ℹ️ ${data.message}`;
  } catch (err) {
    return `❌ ${err}`;
  }
}

async function handleReport(): Promise<string> {
  const [orders, status] = await Promise.allSettled([handleOrders(), handleStatus()]);
  return `📊 *Raport - ${new Date().toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" })}*\n\n${orders.status === "fulfilled" ? orders.value : "❌"}\n\n━━━━━━━━━━━━\n\n${status.status === "fulfilled" ? status.value : "❌"}`;
}

// =============================================
// USER MANAGEMENT (admin)
// =============================================

async function handleAddUser(args: string): Promise<string> {
  if (!args || args.split(/\s+/).length < 3) {
    return `👥 *Adauga utilizator*\n\nFormat: /adduser [tel] [nume] [pin] [rol]\nRoluri: user, manager, admin\n\nEx: /adduser 0722123456 Maria 5678 manager`;
  }

  const parts = args.split(/\s+/);
  const [phone, name, pin, role] = parts;
  const cleanPhone = phone.replace(/[^0-9]/g, "").replace(/^0/, "40");
  const userRole = role && ["user", "manager", "admin"].includes(role) ? role : "user";

  const db = getDb();
  const { error } = await db.from("zen_users").insert({ phone: cleanPhone, name, pin, role: userRole });

  if (error) return error.code === "23505" ? `❌ ${phone} exista deja.` : `❌ ${error.message}`;

  await sendText(cleanPhone, `🤖 Bun venit la *ZEN Bot*!\n\nPIN-ul tau: *${pin}*\nTrimite PIN-ul pentru a te autentifica.`);
  return `✅ *${name}* (${cleanPhone}) adaugat ca ${userRole}. I-am trimis mesaj.`;
}

async function handleListUsers(): Promise<string> {
  const db = getDb();
  const { data: users } = await db.from("zen_users").select("phone, name, role, is_active, last_login_at").order("name");
  if (!users?.length) return "Niciun utilizator.";

  let msg = "👥 *Utilizatori ZEN*\n\n";
  for (const u of users) {
    const status = u.is_active ? "🟢" : "🔴";
    const lastLogin = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" }) : "niciodata";
    msg += `${status} *${u.name}* (${u.phone}) - ${u.role}\n    Ultima conectare: ${lastLogin}\n`;
  }
  return msg;
}

async function handleEditUser(args: string): Promise<string> {
  if (!args) return `✏️ *Editeaza utilizator*\n\nFormat: /edituser [tel] [camp] [valoare]\nCampuri: name, pin, role, active\n\nEx:\n/edituser 0722123456 role admin\n/edituser 0722123456 pin 9999\n/edituser 0722123456 active off`;

  const parts = args.split(/\s+/);
  if (parts.length < 3) return "Format: /edituser [tel] [camp] [valoare]";

  const [phone, field, ...valueParts] = parts;
  const value = valueParts.join(" ");
  const cleanPhone = phone.replace(/[^0-9]/g, "").replace(/^0/, "40");

  const db = getDb();
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

  switch (field) {
    case "name": updateData.name = value; break;
    case "pin": updateData.pin = value; break;
    case "role":
      if (!["user", "manager", "admin"].includes(value)) return "❌ Rol invalid. Optiuni: user, manager, admin";
      updateData.role = value;
      break;
    case "active":
      updateData.is_active = ["on", "da", "yes", "true", "1"].includes(value.toLowerCase());
      break;
    default:
      return `❌ Camp necunoscut: ${field}. Optiuni: name, pin, role, active`;
  }

  const { data, error } = await db.from("zen_users").update(updateData).eq("phone", cleanPhone).select("name").single();
  if (error || !data) return `❌ Utilizatorul ${phone} nu a fost gasit.`;

  return `✅ *${data.name}* actualizat: ${field} = ${value}`;
}

async function handleDeleteUser(args: string): Promise<string> {
  if (!args) return "Format: /deluser [telefon]";

  const cleanPhone = args.trim().replace(/[^0-9]/g, "").replace(/^0/, "40");
  const db = getDb();

  const { data, error } = await db.from("zen_users").update({ is_active: false, updated_at: new Date().toISOString() }).eq("phone", cleanPhone).select("name").single();
  if (error || !data) return `❌ Utilizatorul nu a fost gasit.`;

  return `✅ *${data.name}* dezactivat.`;
}

// =============================================
// KNOWLEDGE BASE MANAGEMENT (admin)
// =============================================

async function handleKnowledge(args: string): Promise<string> {
  const db = getDb();

  if (!args) {
    const { data } = await db.from("zen_knowledge").select("id, category, title").eq("is_active", true).order("category");
    if (!data?.length) return "📚 Knowledge base gol.";

    let msg = "📚 *Knowledge Base*\n\n";
    let lastCat = "";
    for (const k of data) {
      if (k.category !== lastCat) {
        msg += `\n*${k.category.toUpperCase()}*\n`;
        lastCat = k.category;
      }
      msg += `  ${k.id.slice(0, 6)} - ${k.title}\n`;
    }
    msg += "\nComenzi:\n/kb add [categorie] [titlu] | [continut]\n/kb edit [id] | [continut nou]\n/kb del [id]\n/kb view [id]";
    return msg;
  }

  const subCmd = args.split(/\s+/)[0].toLowerCase();
  const subArgs = args.slice(subCmd.length).trim();

  switch (subCmd) {
    case "add": {
      const pipeIdx = subArgs.indexOf("|");
      if (pipeIdx === -1) return "Format: /kb add [categorie] [titlu] | [continut]\nEx: /kb add procedures Checklist dimineata | 1. Verificare stoc 2. Curatenie 3. Mise en place";

      const header = subArgs.slice(0, pipeIdx).trim();
      const content = subArgs.slice(pipeIdx + 1).trim();
      const headerParts = header.split(/\s+/);
      const category = headerParts[0];
      const title = headerParts.slice(1).join(" ");

      if (!category || !title || !content) return "❌ Toate campurile sunt obligatorii.";

      const { data, error } = await db.from("zen_knowledge").insert({ category, title, content }).select("id").single();
      if (error) return `❌ ${error.message}`;
      return `✅ Articol adaugat: *${title}* (${category})\nID: ${data.id.slice(0, 8)}`;
    }

    case "edit": {
      const pipeIdx = subArgs.indexOf("|");
      if (pipeIdx === -1) return "Format: /kb edit [id] | [continut nou]";

      const id = subArgs.slice(0, pipeIdx).trim();
      const content = subArgs.slice(pipeIdx + 1).trim();

      const { data, error } = await db.from("zen_knowledge").update({ content, updated_at: new Date().toISOString() }).ilike("id", `${id}%`).select("title").single();
      if (error || !data) return `❌ Articol negasit cu ID ${id}`;
      return `✅ *${data.title}* actualizat.`;
    }

    case "del":
    case "delete": {
      const id = subArgs.trim();
      const { data, error } = await db.from("zen_knowledge").update({ is_active: false }).ilike("id", `${id}%`).select("title").single();
      if (error || !data) return `❌ Articol negasit.`;
      return `✅ *${data.title}* sters.`;
    }

    case "view": {
      const id = subArgs.trim();
      const { data } = await db.from("zen_knowledge").select("*").ilike("id", `${id}%`).single();
      if (!data) return `❌ Articol negasit.`;
      return `📚 *${data.title}*\nCategorie: ${data.category}\n\n${data.content}`;
    }

    default:
      return "Subcomenzi: /kb add, /kb edit, /kb del, /kb view\nSau /kb fara argumente pt lista.";
  }
}

// =============================================
// LOGS
// =============================================

async function handleLogs(args: string): Promise<string> {
  const db = getDb();
  const limit = parseInt(args) || 15;

  const { data: logs } = await db
    .from("zen_logs")
    .select("user_phone, command, status, execution_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!logs?.length) return "📝 Niciun log.";

  let msg = `📝 *Ultimele ${logs.length} actiuni*\n\n`;
  for (const l of logs) {
    const time = new Date(l.created_at).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
    msg += `${l.status === "success" ? "✅" : "❌"} ${time} /${l.command} (${l.user_phone?.slice(-4)}) ${l.execution_ms}ms\n`;
  }
  return msg;
}

// =============================================
// CONFIG
// =============================================

async function handleConfig(args: string): Promise<string> {
  if (!args) {
    return `⚙️ *Setari sistem*\n\n/config ore [HH:MM] - Ora trimitere formular\n/config zile [1,2,3,4,5] - Zile active\n/config sheet [ID] - Google Sheet ID\n/config activ [on/off] - Pornire/oprire sistem\n\nEx: /config ore 08:30`;
  }

  const [sub, ...rest] = args.split(/\s+/);
  const value = rest.join(" ");

  // TODO: implement actual config changes via manager API
  return `⚙️ Config *${sub}* setat la: ${value}\n_(implementare in curs)_`;
}

// =============================================
// AI QUERY (GPT-4o, grounded in knowledge base)
// =============================================

async function handleAi(query: string): Promise<string> {
  const db = getDb();

  const { data: knowledge } = await db.from("zen_knowledge").select("category, title, content").eq("is_active", true);

  const kb = (knowledge || [])
    .map((k: { category: string; title: string; content: string }) => `[${k.category}] ${k.title}: ${k.content}`)
    .join("\n\n");

  if (!process.env.OPENAI_API_KEY) return "❌ AI nu e configurat (OPENAI_API_KEY lipseste).";

  try {
    const ai = getOpenAI();
    const res = await ai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `Esti ZEN, asistentul AI al restaurantului Ciorbe si Placinte. Raspunzi STRICT pe baza informatiilor din baza de cunostinte. Daca nu ai informatia, spune clar "Nu am aceasta informatie in baza de cunostinte." NU inventa. Comunici in romana, concis, profesional.

BAZA DE CUNOSTINTE:
${kb}

REGULI:
- Max 3-4 propozitii
- Daca nu e despre business/proceduri/furnizori, refuza politicos
- Citeaza sursa daca e relevant`,
        },
        { role: "user", content: query },
      ],
    });

    const text = res.choices[0]?.message?.content;
    return text ? `🧠 ${text}` : "❌ Fara raspuns.";
  } catch (err) {
    return `❌ AI error: ${String(err)}`;
  }
}

// =============================================
// LOGOUT
// =============================================

async function handleLogout(session: Session): Promise<string> {
  const db = getDb();
  await db.from("zen_sessions").update({ is_authenticated: false, updated_at: new Date().toISOString() }).eq("id", session.id);
  return "👋 Deconectat. Trimite PIN-ul pentru reconectare.";
}

// =============================================
// MAIN MESSAGE HANDLER
// =============================================

export async function handleMessage(chatId: string, text: string): Promise<void> {
  const startTime = Date.now();
  const db = getDb();
  const session = await getOrCreateSession(chatId);

  // --- Not authenticated ---
  if (!session.is_authenticated) {
    const phone = chatId.replace("@s.whatsapp.net", "").replace("@c.us", "");

    const { data: user } = await db.from("zen_users").select("*").eq("phone", phone).eq("is_active", true).single();

    if (!user) {
      await sendText(chatId, "🔒 Nu ai acces. Contacteaza un administrator.");
      return;
    }

    if (user.pin !== text.trim()) {
      await sendText(chatId, "🔑 PIN incorect.");
      return;
    }

    await authenticateSession(session, user as User);
    await sendText(chatId, `✅ Bun venit, *${user.name}*! (${user.role})\n\nScrie help sau orice intrebare.`);
    await log(session, user as User, "login", "", "ok", "success", startTime);
    return;
  }

  // --- Authenticated ---
  const { data: user } = await db.from("zen_users").select("*").eq("id", session.user_id).single();
  if (!user) {
    await sendText(chatId, "❌ Sesiune invalida. Trimite PIN-ul.");
    await db.from("zen_sessions").update({ is_authenticated: false }).eq("id", session.id);
    return;
  }

  const { command, args } = await resolveCommand(text);

  // No command → AI
  if (!command) {
    const response = await handleAi(text);
    await sendText(chatId, response);
    await log(session, user as User, "ai", text, response, "success", startTime);
    return;
  }

  // Permission check
  if (!hasPermission(user as User, command)) {
    const msg = `🚫 Acces interzis. /${command.name} necesita rol: ${command.required_role}`;
    await sendText(chatId, msg);
    await log(session, user as User, command.name, text, msg, "denied", startTime);
    return;
  }

  // Execute
  let response: string;
  try {
    const handler = (command.handler_config as { handler: string }).handler;

    switch (handler) {
      case "help": response = await handleHelp(user as User); break;
      case "system_status": response = await handleStatus(); break;
      case "today_orders": response = await handleOrders(); break;
      case "list_suppliers": response = await handleSuppliers(); break;
      case "trigger_dispatch": response = await handleDispatch(); break;
      case "trigger_sheets": response = await handleSheets(); break;
      case "start_onboarding": response = await handleOnboarding(chatId); break;
      case "daily_report": response = await handleReport(); break;
      case "config_menu": response = await handleConfig(args); break;
      case "toggle_active": response = await handleConfig(`activ ${args}`); break;
      case "add_user": response = await handleAddUser(args); break;
      case "list_users": response = await handleListUsers(); break;
      case "edit_user": response = await handleEditUser(args); break;
      case "delete_user": response = await handleDeleteUser(args); break;
      case "knowledge": response = await handleKnowledge(args); break;
      case "view_logs": response = await handleLogs(args); break;
      case "ai_query": response = await handleAi(args); break;
      case "logout": response = await handleLogout(session); break;
      default: response = `❌ Handler necunoscut: ${handler}`;
    }
  } catch (err) {
    response = `❌ Eroare: ${String(err)}`;
    await log(session, user as User, command.name, text, response, "error", startTime);
    await sendText(chatId, response);
    return;
  }

  await sendText(chatId, response);
  await log(session, user as User, command.name, text, response, "success", startTime);
}
