import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Result of running the pre-finalize gates. Each entry maps to a key=value
 * fragment in the structured log line ("constitution=PASS ratings=PASS").
 */
export type GateResults = {
  constitution: "PASS" | "FAIL";
  ratings: "PASS" | "FAIL";
};

/**
 * Gate 1 — Constitution intact.
 * Checks ~/.openclaw/workspace/CONSTITUTION.md (preferred) or
 * ~/.openclaw/CONSTITUTION.md and considers it intact when the file has
 * at least 14 non-empty lines (1 per Constitution rule).
 *
 * Mirrors notify-stop.sh's gate_constitution(). FAIL is non-fatal — the
 * agent still finalizes; we just include the result in the log + Telegram
 * alert so on-call can investigate.
 */
export function gateConstitution(): GateResults["constitution"] {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".openclaw", "workspace", "CONSTITUTION.md"),
    path.join(home, ".openclaw", "CONSTITUTION.md"),
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      const lines = fs.readFileSync(candidate, "utf8").split("\n").length;
      return lines < 14 ? "FAIL" : "PASS";
    } catch {
      continue;
    }
  }
  // No constitution file found at all — same as bash hook: PASS (light check).
  return "PASS";
}

/**
 * Gate 2 — rate-task ratings store accessible.
 * Mirrors gate_ratings() in notify-stop.sh:
 *   - file missing -> PASS (not used yet)
 *   - file present but unreadable / corrupt -> FAIL
 *
 * We do a cheap "is the file a non-zero readable SQLite header?" check
 * instead of spawning sqlite3, which keeps us in-process and dependency-free.
 */
export function gateRatings(): GateResults["ratings"] {
  const ratingsDb = path.join(os.homedir(), ".openclaw", "data", "task_ratings.sqlite");
  try {
    const stat = fs.statSync(ratingsDb);
    if (!stat.isFile() || stat.size === 0) return "PASS"; // missing/empty = not used
    const fd = fs.openSync(ratingsDb, "r");
    try {
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      // SQLite files start with the literal "SQLite format 3\0".
      const header = buf.toString("utf8", 0, 15);
      return header === "SQLite format 3" ? "PASS" : "FAIL";
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "PASS"; // missing = not used yet
    return "FAIL";
  }
}

export function runGates(): GateResults {
  return {
    constitution: gateConstitution(),
    ratings: gateRatings(),
  };
}

/** "constitution=PASS ratings=PASS " — same wire format as notify-stop.sh. */
export function formatGateResults(results: GateResults): string {
  return `constitution=${results.constitution} ratings=${results.ratings} `;
}
