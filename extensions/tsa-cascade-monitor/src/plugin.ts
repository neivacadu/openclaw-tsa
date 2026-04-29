import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// node:sqlite is built-in in Node 22+ (experimental but stable enough for MVP).
// Avoids extra deps per POL-OPS-06 (zero novas deps externas).
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * MVP cascade monitor.
 *
 * Hook: subagent_spawning. Quando Camada 1 (subagents reais) ativar, esse
 * hook dispara antes de cada subagent ser spawned. Aplica cap diário hard
 * por agentId — se excedido, retorna { status: "error" } e bloqueia spawn.
 *
 * MVP escopo:
 * - cap diário (env CASCADE_DAILY_CAP, default 50)
 * - SQLite local em ~/.openclaw/data/cascade_events.sqlite (node:sqlite)
 * - Telegram alert na 1a vez do dia que cap é atingido (env BOT_TOKEN +
 *   env CASCADE_ALERT_CHAT_ID; alert é silencioso se faltarem)
 * - log JSONL em ~/.openclaw/logs/cascade-monitor.jsonl
 *
 * Por design: enabled:false em openclaw.json. Camada 1 ainda inativa, então
 * mesmo carregado o hook nunca dispara.
 */

let db: DatabaseSync | null = null;
let dailyCap = 50;
let logPath = "";

function ensureDb(): DatabaseSync {
  if (db) return db;
  const home = process.env.HOME ?? homedir();
  const dbPath = process.env.CASCADE_DB_PATH ?? join(home, ".openclaw/data/cascade_events.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = new DatabaseSync(dbPath);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS cascade_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      parent_session TEXT NOT NULL,
      target_agent TEXT NOT NULL,
      layer TEXT NOT NULL,
      blocked INTEGER NOT NULL
    );
  `);
  handle.exec(
    "CREATE INDEX IF NOT EXISTS idx_cascade_agent_ts ON cascade_events(target_agent, ts)",
  );
  handle.exec(`
    CREATE TABLE IF NOT EXISTS alert_sent (
      agent_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      PRIMARY KEY (agent_id, date_key)
    );
  `);
  db = handle;
  return handle;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function countTodayForAgent(handle: DatabaseSync, agentId: string): number {
  const stmt = handle.prepare(
    `SELECT COUNT(*) AS n FROM cascade_events
     WHERE target_agent = ?
       AND blocked = 0
       AND date(ts/1000, 'unixepoch') = date('now')`,
  );
  const row = stmt.get(agentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

function insertEvent(
  handle: DatabaseSync,
  parentSession: string,
  agentId: string,
  layer: string,
  blocked: 0 | 1,
): void {
  handle
    .prepare(
      `INSERT INTO cascade_events (ts, parent_session, target_agent, layer, blocked)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(Date.now(), parentSession, agentId, layer, blocked);
}

function alertAlreadySentToday(handle: DatabaseSync, agentId: string): boolean {
  const row = handle
    .prepare(`SELECT agent_id FROM alert_sent WHERE agent_id = ? AND date_key = ?`)
    .get(agentId, todayKey()) as { agent_id: string } | undefined;
  return Boolean(row);
}

function markAlertSent(handle: DatabaseSync, agentId: string): void {
  handle
    .prepare(`INSERT OR IGNORE INTO alert_sent (agent_id, date_key) VALUES (?, ?)`)
    .run(agentId, todayKey());
}

function appendJsonl(payload: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n";
    appendFileSync(logPath, line);
  } catch {
    /* noop — fail-open on log IO */
  }
}

async function sendTelegramAlert(agentId: string, count: number, cap: number): Promise<void> {
  const botToken = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.CASCADE_ALERT_CHAT_ID ?? "";
  if (!botToken || !chatId) return;
  const text =
    `tsa-cascade-monitor (MVP)\n` +
    `daily cap atingido pra agent=${agentId}\n` +
    `count=${count} cap=${cap}\n` +
    `host=${process.env.HOSTNAME ?? "unknown"} tenant=ace-tsia`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    /* noop — alert é best-effort */
  }
}

export function registerCascadeMonitor(api: OpenClawPluginApi): void {
  const home = process.env.HOME ?? homedir();
  logPath = process.env.CASCADE_LOG_PATH ?? join(home, ".openclaw/logs/cascade-monitor.jsonl");
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* noop */
  }

  const capEnv = process.env.CASCADE_DAILY_CAP;
  const parsed = capEnv ? Number.parseInt(capEnv, 10) : NaN;
  dailyCap = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;

  api.on("subagent_spawning", async (event, ctx) => {
    let handle: DatabaseSync;
    try {
      handle = ensureDb();
    } catch (err) {
      api.logger.error(
        `tsa-cascade-monitor sqlite init failed: ${(err as Error).message}; failing open`,
      );
      return undefined;
    }

    const agentId = event.agentId;
    const parentSession = ctx.requesterSessionKey ?? event.childSessionKey ?? "unknown";
    const today = countTodayForAgent(handle, agentId);

    if (today >= dailyCap) {
      insertEvent(handle, parentSession, agentId, "1", 1);
      appendJsonl({
        action: "blocked",
        agent_id: agentId,
        parent_session: parentSession,
        count: today,
        cap: dailyCap,
      });
      api.logger.warn(
        `tsa-cascade-monitor blocked subagent_spawning agent=${agentId} count=${today} cap=${dailyCap}`,
      );
      if (!alertAlreadySentToday(handle, agentId)) {
        markAlertSent(handle, agentId);
        await sendTelegramAlert(agentId, today, dailyCap);
      }
      return {
        status: "error" as const,
        error: `tsa-cascade-monitor: daily cap ${dailyCap} excedido pra agent=${agentId} (count=${today})`,
      };
    }

    insertEvent(handle, parentSession, agentId, "1", 0);
    appendJsonl({
      action: "allowed",
      agent_id: agentId,
      parent_session: parentSession,
      count: today + 1,
      cap: dailyCap,
    });
    return undefined;
  });
}
