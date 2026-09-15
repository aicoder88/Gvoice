// Entry point for `pnpm test:live`. Runs the parity and pipeline-smoke suites
// with real provider keys and the local Whisper engine allowed — but only when
// the caller explicitly opts in with GVOICE_LIVE=1. Without it, this exits 0
// having done nothing, so it is safe to wire into any automated run.
import { spawnSync } from "node:child_process";

if (process.env.GVOICE_LIVE !== "1") {
  console.log("test:live skipped (set GVOICE_LIVE=1 to run checks against real provider keys)");
  process.exit(0);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("node", ["--test", "--test-force-exit", "scripts/parity/dictation-flow.test.js"]);
run("node", ["--experimental-test-module-mocks", "--test", "scripts/smoke/pipeline-smoke.test.js"]);
