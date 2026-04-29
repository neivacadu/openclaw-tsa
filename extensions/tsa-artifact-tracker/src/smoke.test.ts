/**
 * Smoke test for tsa-artifact-tracker.
 *
 * Runs end-to-end against a temp SQLite DB + temp web root. No network, no prod.
 *
 *   ts-node src/smoke.test.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ArtifactTracker, inferKind, inferPublicUrl, parseArtifactsFromResult } from "./index";

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failures += 1;
    console.error("  FAIL:", msg);
  } else {
    console.log("  ok:", msg);
  }
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main() {
  console.log("== tsa-artifact-tracker smoke ==");

  // 1) Pure heuristics (no I/O).
  console.log("\n[1] heuristics");
  assert(inferKind("/var/www/ace/aula.html") === "html", "inferKind html");
  assert(inferKind("/x/y/report.pdf") === "pdf", "inferKind pdf");
  assert(inferKind("/x/y/data.csv") === "data", "inferKind csv -> data");
  assert(inferKind("/x/y/blob.bin") === "other", "inferKind unknown -> other");

  const mappings = { "/var/www/ace/": "https://ace.caduneiva.com/" };
  assert(
    inferPublicUrl("/var/www/ace/aula.html", mappings) === "https://ace.caduneiva.com/aula.html",
    "inferPublicUrl ace mapping",
  );
  assert(inferPublicUrl("/home/ace/notes.md", mappings) === null, "inferPublicUrl no map -> null");

  // 2) Result parsing: args path, regex, Bash redirect.
  console.log("\n[2] parseArtifactsFromResult");
  const fromArgs = parseArtifactsFromResult("Write", { file_path: "/var/www/ace/test.html" }, "");
  assert(fromArgs.includes("/var/www/ace/test.html"), "extracts from args.file_path");

  const fromText = parseArtifactsFromResult("Write", {}, "wrote /var/www/ace/page.html OK");
  assert(fromText.includes("/var/www/ace/page.html"), 'extracts from "wrote /path" hint');

  const fromBash = parseArtifactsFromResult(
    "Bash",
    { command: "echo hi > /var/www/ace/out.html" },
    "done",
  );
  assert(fromBash.includes("/var/www/ace/out.html"), "extracts Bash redirect target");

  // 3) Full track/search/recent/update flow against a temp DB + temp web root.
  console.log("\n[3] track + search + recent + update");
  const dbDir = tmp("artifact-tracker-");
  const wwwDir = tmp("artifact-www-");
  const dbPath = path.join(dbDir, "artifacts.sqlite");

  const tracker = new ArtifactTracker({
    dbPath,
    publicUrlMappings: { [wwwDir + "/"]: "https://ace.caduneiva.com/" },
    trackedTools: ["Write", "Edit", "Bash"],
    minSize: 10,
    ignorePaths: ["/tmp/x-ignore-marker/"],
  });

  const htmlPath = path.join(wwwDir, "aula-vendas-ace-tsa.html");
  fs.writeFileSync(htmlPath, "<html><body>Aula vendas ACE TSA pilot content</body></html>");

  const tracked = tracker.track("Write", { file_path: htmlPath }, `wrote ${htmlPath}`, {
    agent: "0-creator",
    sessionId: "sess-test-1",
    promptSummary: "gerar aula vendas ace tsa",
  });

  assert(tracked.length === 1, "tracked exactly 1 artifact");
  const a = tracked[0];
  assert(a.kind === "html", "kind = html");
  assert(
    a.public_url === `https://ace.caduneiva.com/aula-vendas-ace-tsa.html`,
    "public_url derived",
  );
  assert(a.created_by_agent === "0-creator", "agent recorded");
  assert(
    typeof a.content_hash === "string" && a.content_hash!.length === 64,
    "sha256 hash recorded",
  );

  const search = tracker.searchByQuery("aula", undefined, 10);
  assert(search.length >= 1 && search[0].path === htmlPath, 'FTS search "aula" hits');

  const recent = tracker.recent(24, 10);
  assert(
    recent.some((r) => r.path === htmlPath),
    "recent(24h) includes the artifact",
  );

  const got = tracker.getByPath(htmlPath);
  assert(got?.path === htmlPath, "getByPath round-trip");

  const updated = tracker.updateStatus(htmlPath, "archived");
  assert(updated === true, "updateStatus archived returns true");
  const searchAfter = tracker.searchByQuery("aula", undefined, 10);
  assert(
    !searchAfter.some((r) => r.path === htmlPath),
    "archived artifact dropped from default search",
  );

  // 4) Idempotency: re-tracking same path must upsert, not duplicate.
  console.log("\n[4] idempotency");
  tracker.track("Write", { file_path: htmlPath }, `wrote ${htmlPath}`, {});
  const all = tracker["db"]
    .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE path = ?")
    .get(htmlPath) as { n: number };
  assert(all.n === 1, "no duplicate row on re-track");

  // 5) Metrics shape.
  console.log("\n[5] metrics");
  const m = tracker.metrics();
  assert(m.tsa_artifacts_searches_total >= 2, "searches counter incremented");
  assert(typeof m.tsa_artifacts_tracked_total === "object", "tracked counter map exists");
  assert(typeof m.tsa_artifacts_total === "object", "status gauge exists");

  tracker.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(wwwDir, { recursive: true, force: true });

  console.log(failures === 0 ? "\nALL SMOKE OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
