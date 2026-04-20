/**
 * ZEN Agent Tools - all available tools the AI can call autonomously.
 * Each tool has a schema (for OpenAI) and an execute function.
 */

import { getDb } from "./supabase";
import { sendText } from "./whapi";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const MANAGER_URL = process.env.MANAGER_INTERNAL_URL || process.env.MANAGER_API_URL || "https://manager.zed-zen.com";
const MANAGER_SECRET = process.env.MANAGER_CRON_SECRET || "";

// --- Helper ---

async function managerFetch(path: string, method = "POST", body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${MANAGER_SECRET}` };
  const opts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${MANAGER_URL}${path}`, opts);
  return res.json();
}

// =============================================
// TOOL DEFINITIONS (OpenAI function schemas)
// =============================================

export const toolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_system_status",
      description: "Verifica statusul sistemului: bot online, manager API, numar utilizatori, sesiuni active, knowledge base",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_today_orders",
      description: "Verifica Google Sheets si returneaza comenzile de azi cu statusul lor (procesate, produse gasite, etc)",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_suppliers",
      description: "Lista toti furnizorii activi cu date de contact (telefon, email, persoana contact, categorie)",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_orders",
      description: "Trimite comenzile compilate catre furnizori prin WhatsApp. Foloseste doar cand utilizatorul cere explicit sa trimita comenzile.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_sheets",
      description: "Verifica Google Sheets pentru raspunsuri noi de la locatii (fara a trimite la furnizori)",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "start_onboarding",
      description: "Porneste flow-ul de completare date furnizori prin conversatie WhatsApp",
      parameters: {
        type: "object",
        properties: { chat_id: { type: "string", description: "WhatsApp chat ID" } },
        required: ["chat_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Cauta in baza de cunostinte informatii despre proceduri, furnizori, reguli, business. Foloseste pentru orice intrebare despre cum functioneaza lucrurile.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Ce cauti (ex: procedura comenzi, furnizori pepsi, reguli)" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_knowledge",
      description: "Adauga un articol nou in baza de cunostinte. Doar admin.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Categoria: business, procedures, suppliers, policies" },
          title: { type: "string", description: "Titlul articolului" },
          content: { type: "string", description: "Continutul complet" },
        },
        required: ["category", "title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_knowledge",
      description: "Editeaza un articol existent din baza de cunostinte. Doar admin.",
      parameters: {
        type: "object",
        properties: {
          id_prefix: { type: "string", description: "Primele caractere din ID-ul articolului" },
          new_content: { type: "string", description: "Continutul nou" },
        },
        required: ["id_prefix", "new_content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_knowledge",
      description: "Sterge un articol din baza de cunostinte. Doar admin.",
      parameters: {
        type: "object",
        properties: { id_prefix: { type: "string", description: "Primele caractere din ID-ul articolului" } },
        required: ["id_prefix"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_knowledge",
      description: "Listeaza toate articolele din baza de cunostinte cu ID, categorie si titlu",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_users",
      description: "Lista toti utilizatorii botului cu rol, status si ultima conectare. Doar admin.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_user",
      description: "Adauga un utilizator nou care poate folosi botul. Doar admin.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Numar telefon (ex: 0722123456)" },
          name: { type: "string", description: "Numele persoanei" },
          pin: { type: "string", description: "PIN de autentificare (4-6 cifre)" },
          role: { type: "string", enum: ["user", "manager", "admin"], description: "Rolul utilizatorului" },
        },
        required: ["phone", "name", "pin", "role"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_user",
      description: "Editeaza un utilizator existent (schimba rol, pin, nume, sau activeaza/dezactiveaza). Doar admin.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Numar telefon al utilizatorului" },
          field: { type: "string", enum: ["name", "pin", "role", "active"], description: "Campul de editat" },
          value: { type: "string", description: "Valoarea noua" },
        },
        required: ["phone", "field", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_logs",
      description: "Vezi ultimele actiuni/comenzi executate in bot. Doar admin.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Cate loguri sa afiseze (default 10)" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_whatsapp_message",
      description: "Trimite un mesaj WhatsApp catre un numar de telefon sau chat ID",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Numar telefon sau chat ID" },
          message: { type: "string", description: "Textul mesajului" },
        },
        required: ["to", "message"],
      },
    },
  },
];

// =============================================
// TOOL EXECUTORS
// =============================================

export async function executeTool(name: string, args: Record<string, unknown>, userRole: string, chatId: string): Promise<string> {
  const db = getDb();

  // Permission check for admin-only tools
  const adminTools = ["add_knowledge", "edit_knowledge", "delete_knowledge", "list_users", "add_user", "edit_user", "view_logs"];
  const managerTools = ["dispatch_orders", "check_sheets", "start_onboarding"];

  if (adminTools.includes(name) && userRole !== "admin") {
    return "EROARE: Aceasta actiune necesita rol admin.";
  }
  if (managerTools.includes(name) && !["admin", "manager"].includes(userRole)) {
    return "EROARE: Aceasta actiune necesita rol manager sau admin.";
  }

  try {
    switch (name) {
      // --- System ---
      case "get_system_status": {
        const [users, sessions, logs, knowledge] = await Promise.all([
          db.from("zen_users").select("*", { count: "exact", head: true }).eq("is_active", true),
          db.from("zen_sessions").select("*", { count: "exact", head: true }).eq("is_authenticated", true).gt("expires_at", new Date().toISOString()),
          db.from("zen_logs").select("*", { count: "exact", head: true }),
          db.from("zen_knowledge").select("*", { count: "exact", head: true }).eq("is_active", true),
        ]);
        let managerOk = false;
        try { const r = await fetch(`${MANAGER_URL}/api/health`); managerOk = r.ok; } catch { /* */ }
        return JSON.stringify({
          bot: "online",
          manager_api: managerOk ? "online" : "offline",
          users: users.count || 0,
          active_sessions: sessions.count || 0,
          total_commands: logs.count || 0,
          knowledge_articles: knowledge.count || 0,
          time: new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" }),
        });
      }

      // --- Orders ---
      case "get_today_orders": {
        const data = await managerFetch("/api/cron/supplier-sheets");
        return JSON.stringify(data);
      }
      case "dispatch_orders": {
        const data = await managerFetch("/api/cron/supplier-dispatch");
        return JSON.stringify(data);
      }
      case "check_sheets": {
        const data = await managerFetch("/api/cron/supplier-sheets");
        return JSON.stringify(data);
      }

      // --- Suppliers ---
      case "list_suppliers": {
        const res = await fetch(`${MANAGER_URL}/api/suppliers`, {
          headers: { Authorization: `Bearer ${MANAGER_SECRET}` },
        });
        const suppliers = await res.json();
        return JSON.stringify(suppliers);
      }
      case "start_onboarding": {
        const data = await managerFetch("/api/suppliers/onboarding", "POST", { chat_id: args.chat_id || chatId });
        return JSON.stringify(data);
      }

      // --- Knowledge ---
      case "search_knowledge": {
        const { data } = await db.from("zen_knowledge").select("category, title, content").eq("is_active", true);
        // Simple keyword search
        const query = String(args.query || "").toLowerCase();
        const results = (data || []).filter(
          (k: { title: string; content: string; category: string }) =>
            k.title.toLowerCase().includes(query) ||
            k.content.toLowerCase().includes(query) ||
            k.category.toLowerCase().includes(query)
        );
        return results.length > 0
          ? results.map((k: { category: string; title: string; content: string }) => `[${k.category}] ${k.title}: ${k.content}`).join("\n\n")
          : "Nu am gasit informatii relevante in baza de cunostinte.";
      }
      case "list_knowledge": {
        const { data } = await db.from("zen_knowledge").select("id, category, title").eq("is_active", true).order("category");
        return JSON.stringify((data || []).map((k: { id: string; category: string; title: string }) => ({
          id: k.id.slice(0, 8),
          category: k.category,
          title: k.title,
        })));
      }
      case "add_knowledge": {
        const { data, error } = await db.from("zen_knowledge")
          .insert({ category: args.category, title: args.title, content: args.content })
          .select("id").single();
        if (error) return `EROARE: ${error.message}`;
        return `Articol adaugat cu ID: ${(data as { id: string }).id.slice(0, 8)}`;
      }
      case "edit_knowledge": {
        const { data, error } = await db.from("zen_knowledge")
          .update({ content: args.new_content, updated_at: new Date().toISOString() })
          .ilike("id", `${args.id_prefix}%`)
          .select("title").single();
        if (error || !data) return "EROARE: Articol negasit.";
        return `Articol "${(data as { title: string }).title}" actualizat.`;
      }
      case "delete_knowledge": {
        const { data, error } = await db.from("zen_knowledge")
          .update({ is_active: false })
          .ilike("id", `${args.id_prefix}%`)
          .select("title").single();
        if (error || !data) return "EROARE: Articol negasit.";
        return `Articol "${(data as { title: string }).title}" sters.`;
      }

      // --- Users ---
      case "list_users": {
        const { data } = await db.from("zen_users").select("phone, name, role, is_active, last_login_at").order("name");
        return JSON.stringify(data);
      }
      case "add_user": {
        const phone = String(args.phone).replace(/[^0-9]/g, "").replace(/^0/, "40");
        const { error } = await db.from("zen_users").insert({
          phone, name: args.name, pin: args.pin, role: args.role,
        });
        if (error) return error.code === "23505" ? "EROARE: Numarul exista deja." : `EROARE: ${error.message}`;
        await sendText(phone, `🤖 Bun venit la *ZEN Bot*!\nPIN-ul tau: *${args.pin}*\nTrimite PIN-ul pentru autentificare.`);
        return `Utilizator ${args.name} (${phone}) adaugat ca ${args.role}. Mesaj de bun venit trimis.`;
      }
      case "edit_user": {
        const phone = String(args.phone).replace(/[^0-9]/g, "").replace(/^0/, "40");
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        const field = String(args.field);
        const value = String(args.value);
        if (field === "active") update.is_active = ["on", "da", "yes", "true", "1"].includes(value.toLowerCase());
        else if (field === "role" && ["user", "manager", "admin"].includes(value)) update.role = value;
        else if (field === "name") update.name = value;
        else if (field === "pin") update.pin = value;
        else return `EROARE: Camp invalid "${field}". Optiuni: name, pin, role, active`;

        const { data, error } = await db.from("zen_users").update(update).eq("phone", phone).select("name").single();
        if (error || !data) return "EROARE: Utilizator negasit.";
        return `${(data as { name: string }).name} actualizat: ${field} = ${value}`;
      }

      // --- Logs ---
      case "view_logs": {
        const limit = Number(args.limit) || 10;
        const { data } = await db.from("zen_logs")
          .select("user_phone, command, status, execution_ms, created_at")
          .order("created_at", { ascending: false }).limit(limit);
        return JSON.stringify(data);
      }

      // --- WhatsApp ---
      case "send_whatsapp_message": {
        const result = await sendText(String(args.to), String(args.message));
        return result.id ? `Mesaj trimis (ID: ${result.id})` : `EROARE: ${result.error}`;
      }

      default:
        return `Tool necunoscut: ${name}`;
    }
  } catch (err) {
    return `EROARE: ${String(err)}`;
  }
}
