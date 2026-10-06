// Run the app repository's SDK scripts against this repository.
//
// `scripts/app/generate-sdk-types.mjs` (writes src/schema.ts and its marked
// src/index.ts export block) and
// `scripts/app/check-sdk-openapi-drift.mjs` (the operation table, query
// parameters and Idempotency-Key set agree with the document) are copied
// verbatim from 0xinsider/0xinsider by `scripts/sync-from-app.mjs`, so this
// repository runs exactly the generator and drift gate the app runs. They
// resolve their paths from their own location as the app lays them out:
// `web/public/api/v1/openapi.json`, `sdk/src/`, `scripts/`. This builds that
// layout in a temporary directory, with the chosen document bytes as the spec
// and this repository's `src/` linked in as `sdk/src/`, and runs the script
// there. Never edit `scripts/app/`; sync it.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The app scripts this repository vendors, by file name. */
export const APP_SCRIPTS = ["generate-sdk-types.mjs", "check-sdk-openapi-drift.mjs"];

/**
 * Run `scripts/app/<script>` with `specBytes` as the app's OpenAPI document and
 * this repository's `src/` as the app's `sdk/src/`. Output is inherited; the
 * exit status is returned. A write through `sdk/src/` lands in `src/`.
 */
export function runAppScript(script, specBytes, args = []) {
  if (!APP_SCRIPTS.includes(script)) throw new Error(`not a vendored app script: ${script}`);
  const root = mkdtempSync(join(tmpdir(), "oxinsider-app-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const name of APP_SCRIPTS) {
      copyFileSync(join(repoRoot, "scripts/app", name), join(root, "scripts", name));
    }
    mkdirSync(join(root, "web/public/api/v1"), { recursive: true });
    writeFileSync(join(root, "web/public/api/v1/openapi.json"), specBytes);
    mkdirSync(join(root, "sdk"));
    // "junction" lets Windows link a directory without elevated rights; other
    // platforms ignore the type.
    symlinkSync(join(repoRoot, "src"), join(root, "sdk/src"), "junction");
    const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    // Removes the link itself, never the linked src/.
    rmSync(root, { recursive: true, force: true });
  }
}
