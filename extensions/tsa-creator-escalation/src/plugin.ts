import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * MVP Creator escalation (Camada 1 v1.5, anexo 05 secao 2).
 *
 * CREATOR propoe skill -> precisa aprovacao Cadu via topico Operacoes 4770
 * (POL-COMM-02). Se Cadu offline 24h+ task pendente trava. Plugin escala em
 * 3 niveis:
 *  - 30min sem aprovacao: ACE responde ao usuario com ETA (PT-BR, CONST-08)
 *  - 24h: marca status=stale, skill fica em lab/
 *  - 48h: DM @ace_tsia_bot pra Cadu (chat_id 601478643)
 *
 * Comando /approve-skill <id> no topico 4770 -> webhook -> propaga
 * (POL-PROVISION-03). enabled:false em openclaw.json por default.
 */

const TOPIC_OPERACOES = 4770;
const CADU_CHAT_ID = 601478643;
const T_30MIN_MS = 30 * 60 * 1000;
const T_24H_MS = 24 * 60 * 60 * 1000;
const T_48H_MS = 48 * 60 * 60 * 1000;
const CRON_INTERVAL_MS = 30 * 60 * 1000; // 30min

let db: DatabaseSync | null = null;
let logPath = "";
let cronTimer: NodeJS.Timeout | null = null;

interface PendingRow {
  id: string;
  task_id: string;
  proposed_path: string;
  user_chat_id: number | null;
  created_at: number;
  status: string;
  notified_30min: number;
  notified_24h: number;
  notified_48h: number;
}

function ensureDb(): DatabaseSync {
  if (db) return db;
  const home = process.env.HOME ?? homedir();
  const dbPath =
    process.env.CREATOR_ESCALATION_DB_PATH ??
    join(home, ".openclaw/data/skills_pending_approval.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = new DatabaseSync(dbPath);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS skills_pending_approval (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      proposed_path TEXT,
      user_chat_id INTEGER,
      created_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      notified_30min INTEGER DEFAULT 0,
      notified_24h INTEGER DEFAULT 0,
      notified_48h INTEGER DEFAULT 0,
      approved_at INTEGER,
      approved_by TEXT
    );
  `);
  handle.exec(
    "CREATE INDEX IF NOT EXISTS idx_skills_status_created ON skills_pending_approval(status, created_at)",
  );
  db = handle;
  return handle;
}

function appendJsonl(payload: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n";
    appendFileSync(logPath, line);
  } catch {
    /* fail-open on log IO */
  }
}

function botToken(): string {
  return process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
}

async function tg(chatId: number | string, text: string, threadId?: number): Promise<void> {
  const token = botToken();
  if (!token) return;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (threadId !== undefined) body.message_thread_id = threadId;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort */
  }
}

function operacoesChatId(): string | number {
  // Topic 4770 lives in the Operacoes supergroup; chat_id passed via env.
  return process.env.OPERACOES_CHAT_ID ?? CADU_CHAT_ID;
}

function looksLikeCreatorSkill(path: string): boolean {
  // Heuristica: skills propostas pelo CREATOR ficam em lab/ ou skills/<owner>/
  if (!path) return false;
  return /(^|\/)(lab|skills)\//.test(path) && /\.(md|ya?ml|json|ts|js|sh)$/.test(path);
}

function insertPending(
  handle: DatabaseSync,
  id: string,
  taskId: string,
  proposedPath: string,
  userChatId: number | null,
): void {
  handle
    .prepare(
      `INSERT OR IGNORE INTO skills_pending_approval
        (id, task_id, proposed_path, user_chat_id, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(id, taskId, proposedPath, userChatId, Date.now());
}

async function processPending(api: OpenClawPluginApi): Promise<void> {
  let handle: DatabaseSync;
  try {
    handle = ensureDb();
  } catch (err) {
    api.logger.error(`tsa-creator-escalation cron sqlite init failed: ${(err as Error).message}`);
    return;
  }

  const rows = handle
    .prepare(`SELECT * FROM skills_pending_approval WHERE status = 'pending'`)
    .all() as unknown as PendingRow[];

  const now = Date.now();
  for (const row of rows) {
    const age = now - row.created_at;

    if (age >= T_30MIN_MS && row.notified_30min === 0) {
      const eta = new Date(row.created_at + T_24H_MS).toLocaleString("pt-BR");
      if (row.user_chat_id) {
        await tg(
          row.user_chat_id,
          `Estou criando uma analise nova pra esse caso. Levo um tempo extra; te aviso quando estiver pronta. Estimativa: ${eta}.`,
        );
      }
      handle
        .prepare(`UPDATE skills_pending_approval SET notified_30min = 1 WHERE id = ?`)
        .run(row.id);
      appendJsonl({ action: "notify_30min", id: row.id });
    }

    if (age >= T_24H_MS && row.notified_24h === 0) {
      handle
        .prepare(
          `UPDATE skills_pending_approval SET status = 'stale', notified_24h = 1 WHERE id = ?`,
        )
        .run(row.id);
      appendJsonl({ action: "mark_stale", id: row.id, path: row.proposed_path });
      api.logger.warn(
        `tsa-creator-escalation: skill ${row.id} marcada stale (24h sem aprovacao) path=${row.proposed_path}`,
      );
    }

    if (age >= T_48H_MS && row.notified_48h === 0) {
      await tg(
        CADU_CHAT_ID,
        `Skill ${row.id} aguardando sua aprovacao ha 48h: \`${row.proposed_path}\`. Aprovar com \`/approve-skill ${row.id}\``,
      );
      handle
        .prepare(`UPDATE skills_pending_approval SET notified_48h = 1 WHERE id = ?`)
        .run(row.id);
      appendJsonl({ action: "dm_cadu_48h", id: row.id });
    }
  }
}

async function handleApproveCommand(
  api: OpenClawPluginApi,
  skillId: string,
  approver: string,
): Promise<void> {
  const handle = ensureDb();
  const row = handle
    .prepare(`SELECT * FROM skills_pending_approval WHERE id = ?`)
    .get(skillId) as unknown as PendingRow | undefined;
  if (!row) {
    appendJsonl({ action: "approve_unknown_id", id: skillId });
    return;
  }
  handle
    .prepare(
      `UPDATE skills_pending_approval SET status='approved', approved_at=?, approved_by=? WHERE id=?`,
    )
    .run(Date.now(), approver, skillId);
  appendJsonl({
    action: "approved",
    id: skillId,
    path: row.proposed_path,
    approver,
  });
  await tg(
    operacoesChatId(),
    `Skill \`${skillId}\` aprovada e marcada para promocao (POL-PROVISION-03). Path: \`${row.proposed_path}\``,
    TOPIC_OPERACOES,
  );
  api.logger.info(
    `tsa-creator-escalation: skill ${skillId} approved by ${approver} path=${row.proposed_path}`,
  );
}

export function registerCreatorEscalation(api: OpenClawPluginApi): void {
  const home = process.env.HOME ?? homedir();
  logPath =
    process.env.CREATOR_ESCALATION_LOG_PATH ??
    join(home, ".openclaw/logs/creator-escalation.jsonl");
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* noop */
  }

  // Hook 1: detect CREATOR proposing a new skill via Write/Edit tool calls
  // landing in lab/ or skills/. This is a stand-in for the canonical
  // `after_creator_proposes_skill` hook (not yet emitted by the runtime).
  api.on("after_tool_call", async (event, ctx) => {
    try {
      const toolName = event.toolName ?? "";
      if (toolName !== "Write" && toolName !== "Edit") return undefined;
      const params = event.params ?? {};
      const filePath =
        (params.file_path as string | undefined) ?? (params.path as string | undefined) ?? "";
      if (!looksLikeCreatorSkill(filePath)) return undefined;

      const taskId = ctx.sessionKey ?? "unknown-task";
      const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const handle = ensureDb();
      insertPending(handle, id, taskId, filePath, null);
      appendJsonl({ action: "proposed", id, path: filePath, task_id: taskId });
      await tg(
        operacoesChatId(),
        `Nova skill \`${filePath}\` aguardando aprovacao.\nUse \`/approve-skill ${id}\` ou \`/reject-skill ${id}\`.`,
        TOPIC_OPERACOES,
      );
    } catch (err) {
      api.logger.error(`tsa-creator-escalation after_tool_call failed: ${(err as Error).message}`);
    }
    return undefined;
  });

  // Hook 2: webhook for /approve-skill <id> in topic 4770. Inbound messages
  // arrive via inbound_claim; we filter by content + topic before acting.
  api.on("inbound_claim", async (event) => {
    try {
      const text = (event.content ?? "").trim();
      const match = /^\/approve-skill\s+(\S+)/.exec(text);
      if (!match) return undefined;
      const threadId = event.threadId;
      const topicNum = typeof threadId === "string" ? Number(threadId) : threadId;
      if (topicNum !== TOPIC_OPERACOES) return undefined;
      const skillId = match[1];
      const approver = event.senderId?.toString() ?? "unknown";
      await handleApproveCommand(api, skillId, approver);
    } catch (err) {
      api.logger.error(`tsa-creator-escalation inbound_claim failed: ${(err as Error).message}`);
    }
    return undefined;
  });

  // Internal cron — setInterval 30min. processPending runs the 3-tier ladder.
  // Wrapped so a single failure does not kill the timer.
  const tick = (): void => {
    processPending(api).catch((err: Error) => {
      api.logger.error(`tsa-creator-escalation cron tick failed: ${err.message}`);
    });
  };
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(tick, CRON_INTERVAL_MS);
  // unref so the timer never blocks process exit (matches OpenClaw shutdown).
  if (typeof cronTimer.unref === "function") cronTimer.unref();
}
