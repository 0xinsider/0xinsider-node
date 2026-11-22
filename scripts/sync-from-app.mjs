#!/usr/bin/env node
// Sync the hand-written SDK sources from the app repository.
//
// The SDK is authored in 0xinsider/0xinsider under `sdk/`: its drift gates make
// a new or changed API route update `sdk/src/client.ts` in the same pull
// request, and the 0xinsider CLI and MCP server compile that directory. This
// repository is where the package is built, tested and published. This script
// copies every `sdk/src/*.ts` file, the example, the app's SDK generator and
// drift gate (into `scripts/app/`), and the package version from an app
// checkout, then re-adds the one thing this repository has that the app does
// not: the provenance export in `src/index.ts`.
//
// THE CONTRACT COMES FROM THE SAME COMMIT. The app's OpenAPI document at --ref
// (`web/public/api/v1/openapi.json`) is copied byte for byte into `openapi.json`,
// `sdk/src/schema.ts` (the app's generator ran on that document) is copied like
// every other source, and `src/provenance.ts` is written for that document,
// with APP_COMMIT the commit at or before --ref that last changed it. Before
// 0xinsider-node#91, `scripts/generate.mjs` fetched the live document instead,
// so a release generated before the app deploy served --ref published the
// previous types under a version and APP_COMMIT that claimed --ref; and
// `--check` skipped `schema.ts`, so nothing noticed. Now `--check` compares
// all three with the app at --ref, and no step of a release reads the live site.
//
// Usage:
//   node scripts/sync-from-app.mjs                     # ../0xinsider at origin/main
//   node scripts/sync-from-app.mjs --app ~/Work/0xinsider --ref origin/main
//   node scripts/sync-from-app.mjs --check             # exit 1 when out of sync
//
// The app repository is private: the checkout needs read access. `.app-sdk-commit`
// records the app commit the sources came from; `git -C <app> log
// <that commit>..origin/main -- sdk` lists what changed since.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_SCRIPTS } from "./app-shim.mjs";
import { APP_REPOSITORY, APP_SPEC_PATH, documentOperationCount, renderProvenance, sha256 } from "./generate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const app = resolve(option("--app", resolve(root, "..", "0xinsider")));
const ref = option("--ref", "origin/main");
const check = args.includes("--check");

// Written here, for the app's document at --ref; the app has no such file.
const GENERATED = new Set(["provenance.ts"]);
const EXAMPLE = "examples/sdk-list-s-grade-wallets.ts";
const PROVENANCE_EXPORT = `// Which OpenAPI document this release was generated from (scripts/generate.mjs).
// Compare OPENAPI_SHA256 with the SHA-256 of the live document to see whether a
// release is behind the API.
export {
  APP_COMMIT,
  APP_REPOSITORY,
  APP_SPEC_PATH,
  OPENAPI_SHA256,
  OPENAPI_SOURCE,
  OPENAPI_VERSION,
  OPERATION_COUNT,
} from "./provenance.js";

`;
const PROVENANCE_ANCHOR = "// Generated contract types";

function git(...gitArgs) {
  return execFileSync("git", ["-C", app, ...gitArgs], { encoding: "utf8", maxBuffer: 64 << 20 });
}

/** The exact bytes git prints, for a file that must be copied byte for byte. */
function gitBytes(...gitArgs) {
  return execFileSync("git", ["-C", app, ...gitArgs], { maxBuffer: 64 << 20 });
}

function fail(message) {
  console.error(`sync-from-app: ${message}`);
  process.exit(1);
}

if (!existsSync(resolve(app, ".git"))) {
  fail(`no git checkout of 0xinsider/0xinsider at ${app}; pass --app <path>`);
}
const commit = git("rev-parse", `${ref}^{commit}`).trim();

const appSources = git("ls-tree", "--name-only", `${ref}:sdk/src`)
  .split("\n")
  .filter((name) => name.endsWith(".ts") && !GENERATED.has(name));

const wanted = new Map();
for (const name of appSources) {
  let text = git("show", `${ref}:sdk/src/${name}`);
  if (name === "index.ts") {
    const at = text.indexOf(PROVENANCE_ANCHOR);
    if (at === -1) {
      fail(`sdk/src/index.ts at ${commit.slice(0, 10)} no longer has "${PROVENANCE_ANCHOR}"; place the provenance export by hand and update this script`);
    }
    text = text.slice(0, at) + PROVENANCE_EXPORT + text.slice(at);
  }
  wanted.set(`src/${name}`, text);
}
wanted.set(EXAMPLE, git("show", `${ref}:sdk/${EXAMPLE}`));
// The app's generator and drift gate, run here through scripts/app-shim.mjs.
for (const name of APP_SCRIPTS) {
  wanted.set(`scripts/app/${name}`, git("show", `${ref}:scripts/${name}`));
}

// The OpenAPI document at --ref and the provenance that names it.
// `src/schema.ts` came from the same commit with the sources above.
const specBytes = gitBytes("show", `${ref}:${APP_SPEC_PATH}`);
const spec = JSON.parse(specBytes.toString("utf8"));
const specCommit = git("log", "-1", "--format=%H", commit, "--", APP_SPEC_PATH).trim();
if (!specCommit) fail(`no commit at or before ${commit.slice(0, 10)} changed ${APP_SPEC_PATH}`);
wanted.set("openapi.json", specBytes);
wanted.set(
  "src/provenance.ts",
  renderProvenance({
    source: `${APP_REPOSITORY}:${APP_SPEC_PATH}`,
    sha256: sha256(specBytes),
    version: spec.info?.version ?? "unknown",
    operationCount: documentOperationCount(spec),
    appCommit: specCommit,
  }),
);

const appPackage = JSON.parse(git("show", `${ref}:sdk/package.json`));
const ourPackagePath = resolve(root, "package.json");
const ourPackage = JSON.parse(readFileSync(ourPackagePath, "utf8"));
const syncedPackage = { ...ourPackage, version: appPackage.version, devDependencies: appPackage.devDependencies };
wanted.set("package.json", `${JSON.stringify(syncedPackage, null, 2)}\n`);
wanted.set(".app-sdk-commit", `${commit}\n`);

const stale = [];
for (const [path, content] of wanted) {
  const target = resolve(root, path);
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const current = existsSync(target) ? readFileSync(target) : null;
  if (current !== null && current.equals(bytes)) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}
// A hand-written file the app removed is reported, never deleted silently.
const orphans = readdirSync(resolve(root, "src"))
  .filter((name) => name.endsWith(".ts") && !GENERATED.has(name) && !appSources.includes(name))
  .map((name) => `src/${name}`);

if (check) {
  if (stale.length || orphans.length) {
    console.error(`sync-from-app --check: out of sync with 0xinsider/0xinsider@${commit.slice(0, 10)}`);
    for (const path of stale) console.error(`  differs: ${path}`);
    for (const path of orphans) console.error(`  not in the app: ${path}`);
    process.exit(1);
  }
  console.log(
    `sync-from-app --check: OK (0xinsider/0xinsider@${commit.slice(0, 10)}, ${appSources.length} sources, openapi.json sha256 ${sha256(specBytes)})`,
  );
  process.exit(0);
}

console.log(
  `sync-from-app: synced from 0xinsider/0xinsider@${commit.slice(0, 10)} (version ${appPackage.version}, openapi.json sha256 ${sha256(specBytes)}, last changed at ${specCommit.slice(0, 10)})`,
);
for (const path of stale) console.log(`  updated: ${path}`);
for (const path of orphans) console.log(`  not in the app (remove it if the app removed it): ${path}`);
if (!stale.length) console.log("  nothing changed");
if (stale.includes("package.json")) {
  console.log("next: npm install (refresh the lockfile), npm run check, npm test, and port any sdk/README.md change");
}
