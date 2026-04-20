/**
 * Cross-service API calls to manager.zed-zen.com
 * For accessing supplier data, orders, configs, etc.
 */

const MANAGER_URL = process.env.MANAGER_API_URL || "https://manager.zed-zen.com";
const MANAGER_SECRET = process.env.MANAGER_CRON_SECRET || "";

async function managerFetch(path: string, method = "POST", body?: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${MANAGER_SECRET}`,
  };
  const opts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${MANAGER_URL}${path}`, opts);
  return res.json();
}

export async function triggerSheets(daysBack?: number) {
  return managerFetch("/api/cron/supplier-sheets", "POST", daysBack ? { days_back: daysBack } : undefined);
}

export async function triggerDispatch() {
  return managerFetch("/api/cron/supplier-dispatch");
}

export async function triggerOrders() {
  return managerFetch("/api/cron/supplier-orders");
}

export async function startOnboarding(chatId: string) {
  return managerFetch("/api/suppliers/onboarding", "POST", { chat_id: chatId });
}
