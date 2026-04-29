import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parse as yamlParse } from "yaml";

/**
 * tsa-rule-validator (MVP).
 *
 * Valida regras YAML em /opt/tsa-ace-master/rules/ no boot do gateway.
 * Schema fixo + cross-refs + semver + enums. Loga em
 * ~/.openclaw/logs/rule-validator.jsonl. Se erros, alerta Telegram
 * (BOT_TOKEN + RULES_ALERT_CHAT_ID env).
 *
 * enabled:false default (openclaw.json).
 */

const DEFAULT_RULES_DIR = "/opt/tsa-ace-master/rules";
const SEMVER_RE = /^\d+\.\d+(\.\d+)?$/;
const REQUIRED_FIELDS = [
  "id",
  "title",
  "layer",
  "scope",
  "enforcement",
  "authority",
  "status",
  "version",
  "why",
  "applies_when",
  "audit_via",
] as const;
const STATUS_ENUM = new Set(["active", "tbd", "deprecated"]);
const LAYER_ENUM = new Set(["constitution", "policy", "procedure", "reference"]);
const ENFORCEMENT_ENUM = new Set(["hard", "soft", "self"]);

let logPath = "";

type ValidationError = { file: string; rule_id: string | null; error: string };

type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  total_rules: number;
  total_errors: number;
};

function appendJsonl(payload: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n";
    appendFileSync(logPath, line);
  } catch {
    /* noop — fail-open on log IO */
  }
}

function walkYaml(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = resolve(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkYaml(full, acc);
    } else if (st.isFile() && (name.endsWith(".yaml") || name.endsWith(".yml"))) {
      acc.push(full);
    }
  }
}

function validateRule(
  file: string,
  rule: unknown,
  errors: ValidationError[],
  seenIds: Map<string, string>,
): string | null {
  if (!rule || typeof rule !== "object") {
    errors.push({ file, rule_id: null, error: "rule is not an object" });
    return null;
  }
  const r = rule as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r) || r[field] === null || r[field] === undefined || r[field] === "") {
      errors.push({ file, rule_id: id, error: `missing field: ${field}` });
    }
  }
  if (id && seenIds.has(id) && seenIds.get(id) !== file) {
    errors.push({ file, rule_id: id, error: `duplicate id (also in ${seenIds.get(id)})` });
  } else if (id) {
    seenIds.set(id, file);
  }
  if (typeof r.version === "string" && !SEMVER_RE.test(r.version)) {
    errors.push({ file, rule_id: id, error: `invalid semver: ${r.version}` });
  }
  if (typeof r.status === "string" && !STATUS_ENUM.has(r.status)) {
    errors.push({ file, rule_id: id, error: `invalid status enum: ${r.status}` });
  }
  if (typeof r.layer === "string" && !LAYER_ENUM.has(r.layer)) {
    errors.push({ file, rule_id: id, error: `invalid layer enum: ${r.layer}` });
  }
  if (typeof r.enforcement === "string" && !ENFORCEMENT_ENUM.has(r.enforcement)) {
    errors.push({ file, rule_id: id, error: `invalid enforcement enum: ${r.enforcement}` });
  }
  return id;
}

export function validateRulesDirectory(path: string): ValidationResult {
  const errors: ValidationError[] = [];
  const files: string[] = [];
  walkYaml(path, files);
  const seenIds = new Map<string, string>();
  const ruleRefs: { file: string; rule_id: string | null; related: unknown }[] = [];
  let totalRules = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      errors.push({ file, rule_id: null, error: `read failed: ${(err as Error).message}` });
      continue;
    }
    let doc: unknown;
    try {
      doc = yamlParse(raw);
    } catch (err) {
      errors.push({ file, rule_id: null, error: `yaml parse failed: ${(err as Error).message}` });
      continue;
    }
    if (Array.isArray(doc)) {
      for (const rule of doc) {
        totalRules += 1;
        const id = validateRule(file, rule, errors, seenIds);
        const r = rule as Record<string, unknown> | null;
        if (r && "related" in r) ruleRefs.push({ file, rule_id: id, related: r.related });
      }
    } else if (doc && typeof doc === "object") {
      totalRules += 1;
      const id = validateRule(file, doc, errors, seenIds);
      const r = doc as Record<string, unknown>;
      if ("related" in r) ruleRefs.push({ file, rule_id: id, related: r.related });
    } else {
      errors.push({ file, rule_id: null, error: "yaml root not an object/array" });
    }
  }

  for (const ref of ruleRefs) {
    if (ref.related === null || ref.related === undefined) continue;
    const list = Array.isArray(ref.related) ? ref.related : [ref.related];
    for (const target of list) {
      if (typeof target !== "string") {
        errors.push({ file: ref.file, rule_id: ref.rule_id, error: `related entry not string` });
        continue;
      }
      if (!seenIds.has(target)) {
        errors.push({
          file: ref.file,
          rule_id: ref.rule_id,
          error: `cross-ref missing: related -> ${target}`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    total_rules: totalRules,
    total_errors: errors.length,
  };
}

async function sendTelegramAlert(result: ValidationResult): Promise<void> {
  const botToken = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.RULES_ALERT_CHAT_ID ?? process.env.CASCADE_ALERT_CHAT_ID ?? "";
  if (!botToken || !chatId) return;
  const sample = result.errors
    .slice(0, 5)
    .map((e) => `- ${e.rule_id ?? "?"} (${e.error})`)
    .join("\n");
  const text =
    `tsa-rule-validator (MVP)\n` +
    `total_rules=${result.total_rules} errors=${result.total_errors}\n` +
    `host=${process.env.HOSTNAME ?? "unknown"} tenant=ace-tsia\n` +
    `sample:\n${sample}`;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    /* noop — alert é best-effort */
  }
}

export function registerRuleValidator(api: OpenClawPluginApi): void {
  const home = process.env.HOME ?? homedir();
  logPath = process.env.RULES_LOG_PATH ?? join(home, ".openclaw/logs/rule-validator.jsonl");
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* noop */
  }

  const rulesDir = process.env.RULES_DIR ?? DEFAULT_RULES_DIR;

  api.on("gateway_start", async () => {
    let result: ValidationResult;
    try {
      result = validateRulesDirectory(rulesDir);
    } catch (err) {
      api.logger.error(
        `tsa-rule-validator validation crashed: ${(err as Error).message}; failing open`,
      );
      appendJsonl({ action: "crashed", error: (err as Error).message, dir: rulesDir });
      return undefined;
    }
    appendJsonl({
      action: result.valid ? "valid" : "invalid",
      dir: rulesDir,
      total_rules: result.total_rules,
      total_errors: result.total_errors,
      errors: result.errors.slice(0, 50),
    });
    if (result.valid) {
      api.logger.info(`tsa-rule-validator OK total_rules=${result.total_rules} dir=${rulesDir}`);
    } else {
      api.logger.warn(
        `tsa-rule-validator FAILED total_rules=${result.total_rules} errors=${result.total_errors} dir=${rulesDir}`,
      );
      await sendTelegramAlert(result);
    }
    return undefined;
  });
}
