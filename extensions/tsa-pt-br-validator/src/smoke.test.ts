import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Smoke tests para tsa-pt-br-validator (sem dep externa, sem runtime SDK).
 * Roda com: node --test dist/src/smoke.test.js
 *
 * Os 7 testes cobrem a logica pura (validator.ts) — equivalentes aos
 * testes da versao flat-format anterior, mas usam a API nova
 * (validateText/extractText/scoreText) em vez do antigo afterToolCall.
 */
import { test } from "node:test";
import { validateText, scoreText, extractText, type ValidatorConfig } from "./validator.js";

function setupKnowledge(): Pick<
  ValidatorConfig,
  "watchedWordsPath" | "anglicismsPath" | "logPath"
> {
  const dir = mkdtempSync(join(tmpdir(), "ptbr-"));
  writeFileSync(
    join(dir, "palavras.md"),
    `diagnostico -> diagnóstico
analise -> análise
automacao -> automação
configuracao -> configuração
`,
  );
  writeFileSync(
    join(dir, "anglicismos.md"),
    `tenant -> locatário
fingerprint -> impressão digital
rsync -> sync remoto
`,
  );
  return {
    watchedWordsPath: join(dir, "palavras.md"),
    anglicismsPath: join(dir, "anglicismos.md"),
    logPath: join(dir, "log.jsonl"),
  };
}

const baseCfg = (k: ReturnType<typeof setupKnowledge>): ValidatorConfig => ({
  monitorOnly: true,
  scoreThreshold: 7,
  minTextLength: 100,
  ...k,
});

test("texto curto ignora", () => {
  const k = setupKnowledge();
  // simula Write com content "oi"
  const text = extractText("Write", { content: "oi" }, undefined);
  const r = validateText(text, { ...baseCfg(k), minTextLength: 200 });
  assert.equal(r.decision, "allow");
  assert.equal(r.score, undefined);
});

test("texto em ingles puro ignora", () => {
  const k = setupKnowledge();
  const txt = "The quick brown fox jumps over the lazy dog. ".repeat(10);
  const r = validateText(txt, { ...baseCfg(k), minTextLength: 50 });
  assert.equal(r.decision, "allow");
  assert.equal(r.score, undefined);
});

test("pt-br limpo passa com score alto", () => {
  const k = setupKnowledge();
  const txt =
    "O diagnóstico está pronto e a análise foi feita com cuidado. Para isso usamos a configuração padrão e não houve falha. Você precisa do relatório? ".repeat(
      3,
    );
  const { score, issues } = scoreText(txt, baseCfg(k));
  assert.ok(score >= 7, `score baixo demais: ${score}, issues=${JSON.stringify(issues)}`);
});

test("pt-br com palavras sem acento perde pontos", () => {
  const k = setupKnowledge();
  const txt =
    "O diagnostico esta pronto e a analise foi feita. Para isso usamos a configuracao padrao e nao houve falha. Voce precisa do relatorio? ".repeat(
      3,
    );
  const { score, issues } = scoreText(txt, baseCfg(k));
  assert.ok(score < 7, `deveria ter caido: score=${score}`);
  assert.ok(issues.some((i) => i.kind === "missing_accent"));
});

test("anglicismo sem traducao detectado", () => {
  const k = setupKnowledge();
  const txt =
    "O tenant precisa do fingerprint para acessar. Vamos rodar rsync agora. Que coisa para fazer com voce. ".repeat(
      3,
    );
  const { issues } = scoreText(txt, baseCfg(k));
  assert.ok(issues.some((i) => i.kind === "untranslated_anglicism"));
});

test("modo enforcement bloqueia score baixo", () => {
  const k = setupKnowledge();
  const txt =
    "O diagnostico esta pronto e a analise foi feita. Para isso usamos a configuracao padrao e nao houve falha. Voce precisa do relatorio? ".repeat(
      3,
    );
  const r = validateText(txt, { ...baseCfg(k), monitorOnly: false });
  assert.equal(r.decision, "deny");
  assert.ok(r.suggestion);
  assert.ok(r.reason);
});

test("modo monitor nunca bloqueia", () => {
  const k = setupKnowledge();
  const txt =
    "O diagnostico esta pronto e a analise foi feita. Para isso usamos a configuracao padrao e nao houve falha. Voce precisa do relatorio? ".repeat(
      3,
    );
  const r = validateText(txt, { ...baseCfg(k), monitorOnly: true });
  // monitor: pode ser "allow" (score OK) ou "allow_warn" (score baixo) — nunca "deny"
  assert.notEqual(r.decision, "deny");
});
