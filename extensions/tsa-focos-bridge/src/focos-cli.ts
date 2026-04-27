import { spawn } from "node:child_process";

/**
 * Shape returned by `focos decide "<prompt>"`.
 *
 * The Python MVP currently emits exactly these four fields. We keep the
 * type permissive (Record on top of the known fields) so future FOCOS
 * iterations can ship extra metadata without breaking the bridge.
 */
export type FocosDecision = {
  action: string;
  target: string;
  confidence: number;
  reasoning: string;
} & Record<string, unknown>;

export type FocosCallContext = {
  sessionId?: string;
  agentId?: string;
};

export type FocosCallOptions = {
  /** Absolute path to the focos binary. Defaults to /usr/local/bin/focos. */
  binPath?: string;
  /** Hard subprocess timeout. Defaults to 5000ms. */
  timeoutMs?: number;
};

export type FocosCallResult =
  | { ok: true; decision: FocosDecision; stderr?: string }
  | { ok: false; reason: string; exitCode?: number | null; stderr?: string; stdout?: string };

const DEFAULT_BIN = "/usr/local/bin/focos";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Spawn the focos CLI with `decide <prompt>` and parse its stdout JSON.
 *
 * Contract:
 *   - exit 0 + parseable JSON on stdout -> { ok: true, decision }
 *   - any other path -> { ok: false, reason } (caller MUST treat as
 *     pass-through; we never want a routing engine outage to block the
 *     agent loop)
 *
 * sessionId / agentId are propagated as env vars (FOCOS_SESSION_ID /
 * FOCOS_AGENT_ID) so the audit log in /opt/focos/focos.db can correlate
 * decisions back to the originating turn.
 */
export async function decide(
  prompt: string,
  ctx: FocosCallContext = {},
  opts: FocosCallOptions = {},
): Promise<FocosCallResult> {
  const binPath = opts.binPath ?? DEFAULT_BIN;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(binPath, ["decide", prompt], {
        env: {
          ...process.env,
          FOCOS_SESSION_ID: String(ctx.sessionId ?? ""),
          FOCOS_AGENT_ID: String(ctx.agentId ?? ""),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, reason: `spawn error: ${(err as Error).message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: FocosCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      settle({ ok: false, reason: `proc error: ${(err as Error).message}`, stderr, stdout });
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          reason: `focos exited with code ${code}`,
          exitCode: code,
          stdout,
          stderr,
        });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        settle({ ok: false, reason: "focos returned empty stdout", exitCode: code, stderr });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isFocosDecision(parsed)) {
          settle({
            ok: false,
            reason: "focos returned JSON missing required fields",
            stdout: trimmed,
            stderr,
          });
          return;
        }
        settle({ ok: true, decision: parsed, stderr });
      } catch (err) {
        settle({
          ok: false,
          reason: `focos returned invalid JSON: ${(err as Error).message}`,
          stdout: trimmed,
          stderr,
        });
      }
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore — already exited
      }
      settle({ ok: false, reason: `focos timed out after ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);
  });
}

function isFocosDecision(value: unknown): value is FocosDecision {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.action === "string" &&
    typeof v.target === "string" &&
    typeof v.confidence === "number" &&
    typeof v.reasoning === "string"
  );
}
