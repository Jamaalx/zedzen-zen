export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const API_SECRET = process.env.API_SECRET;
    const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    if (!API_SECRET) return;

    console.log("[ZEN CRON] Starting scheduler (every 5 min)");

    setInterval(async () => {
      try {
        await fetch(`${APP_URL}/api/cron`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_SECRET}` },
        });
      } catch (e) {
        console.error("[ZEN CRON] error:", e);
      }
    }, 5 * 60 * 1000);
  }
}
