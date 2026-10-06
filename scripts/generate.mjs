#!/usr/bin/env node
// Generate the SDK's contract types (src/schema.ts and its src/index.ts export
// block) and release provenance
// (src/provenance.ts) from the published 0xinsider OpenAPI document, and keep
// the exact document bytes they came from in openapi.json.
//
//   node scripts/generate.mjs                        # fetch https://0xinsider.com/api/v1/openapi.json
//   node scripts/generate.mjs --spec openapi.json    # regenerate from the committed snapshot
//   SPEC=path/to/openapi.json node scripts/generate.mjs
//   APP_COMMIT=<sha> node scripts/generate.mjs       # the 0xinsider/0xinsider commit the document belongs to
//   node scripts/generate.mjs --check [--spec ...]   # exit 1 if the committed files are stale
//
// THE GENERATOR IS THE APP'S. src/schema.ts is rendered by
// scripts/app/generate-sdk-types.mjs, a verbatim copy of the generator the app
// repository (0xinsider/0xinsider) runs on sdk/src/schema.ts, kept current by
// scripts/sync-from-app.mjs and run through scripts/app-shim.mjs. So this
// package's types are byte-identical to the app's for the same document, and a
// generator change needs no port. This file owns only what the app does not
// do here: fetching the published document, keeping its bytes in openapi.json,
// and src/provenance.ts.
//
// PROVENANCE. src/provenance.ts records the SHA-256 of the document bytes as
// fetched, its info.version, the operation count, and the 0xinsider/0xinsider
// commit that last changed web/public/api/v1/openapi.json: APP_COMMIT when
// set, else a lookup of the GitHub commits API (GH_TOKEN is used when set).
// An app commit that cannot be resolved is recorded as null and reported on
// stderr, never guessed. Regenerating from bytes whose SHA-256 equals the one
// already recorded keeps the recorded source and app commit, so a rebuild from
// the snapshot is byte-identical and needs no network.
//
// --check regenerates in memory and compares: src/schema.ts and the generated
// src/index.ts export block must equal the rendering, and src/provenance.ts
// must name the same document (SHA-256,
// version, operation count). Against the live document (the default source)
// that answers "is this release behind the API"; against --spec openapi.json it
// answers "are the committed files generated from the committed snapshot".

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAppScript } from "./app-shim.mjs";

export const DEFAULT_SOURCE = "https://0xinsider.com/api/v1/openapi.json";
export const APP_REPOSITORY = "0xinsider/0xinsider";
export const APP_SPEC_PATH = "web/public/api/v1/openapi.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(repoRoot, "openapi.json");
const provenancePath = resolve(repoRoot, "src/provenance.ts");

const HTTP_METHODS = new Set(["get", "post", "patch", "delete", "put"]);
const USER_AGENT = "0xinsider-node-generator";

/** `--spec <path>` or `SPEC=<path>`; undefined means fetch DEFAULT_SOURCE. */
export function specArgument(argv = process.argv.slice(2), env = process.env) {
  const index = argv.indexOf("--spec");
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--spec needs a path");
    return value;
  }
  return env.SPEC || undefined;
}

/**
 * The document bytes and where they came from. A local path is read as is; no
 * path fetches the published document. The bytes are hashed exactly as
 * received, before any parsing.
 */
export async function loadSpec(specPath) {
  if (specPath) {
    const path = resolve(process.cwd(), specPath);
    return { raw: readFileSync(path), path, fetched: false };
  }
  const response = await fetch(DEFAULT_SOURCE, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${DEFAULT_SOURCE} answered ${response.status}`);
  }
  return { raw: Buffer.from(await response.arrayBuffer()), path: undefined, fetched: true };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every operation in the document, as Go's OperationCount and Python's OPERATION_COUNT count them. */
export function documentOperationCount(spec) {
  let count = 0;
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (HTTP_METHODS.has(method) && operation?.operationId) count += 1;
    }
  }
  return count;
}

function quote(value) {
  return JSON.stringify(value);
}

/** The identity fields of a rendered or committed src/provenance.ts. */
export function readProvenance(source) {
  const field = (name) => {
    const match = source.match(new RegExp(`export const ${name}(?:: [^=]+)? = (.+);`));
    return match ? JSON.parse(match[1]) : undefined;
  };
  return {
    source: field("OPENAPI_SOURCE"),
    sha256: field("OPENAPI_SHA256"),
    version: field("OPENAPI_VERSION"),
    operationCount: field("OPERATION_COUNT"),
    appCommit: field("APP_COMMIT"),
  };
}

function readIfExists(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** The app commit the document belongs to, or null when it cannot be known. */
async function resolveAppCommit() {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT;
  const url = `https://api.github.com/repos/${APP_REPOSITORY}/commits?path=${APP_SPEC_PATH}&per_page=1`;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const commits = await response.json();
    const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
    if (typeof sha === "string" && sha.length > 0) return sha;
    console.error("warning: the GitHub API listed no commit for the document; recording null");
  } catch (error) {
    console.error(`warning: app commit not resolved from the GitHub API (${error.message}); recording null`);
  }
  return null;
}

export function renderProvenance({ source, sha256: digest, version, operationCount, appCommit }) {
  return [
    "// GENERATED by scripts/generate.mjs. Do not edit.",
    "//",
    "// Which OpenAPI document this release was generated from. OPENAPI_SHA256 is",
    "// the SHA-256 of the document bytes as fetched; APP_COMMIT is the",
    "// 0xinsider/0xinsider commit that last changed web/public/api/v1/openapi.json",
    "// when it could be resolved, else null. Compare OPENAPI_SHA256 with the live",
    "// document to see whether a release is behind the API.",
    "",
    `export const OPENAPI_SOURCE = ${quote(source)};`,
    `export const OPENAPI_SHA256 = ${quote(digest)};`,
    `export const OPENAPI_VERSION = ${quote(version)};`,
    `export const OPERATION_COUNT = ${operationCount};`,
    `export const APP_REPOSITORY = ${quote(APP_REPOSITORY)};`,
    `export const APP_SPEC_PATH = ${quote(APP_SPEC_PATH)};`,
    `export const APP_COMMIT: string | null = ${quote(appCommit)};`,
    "",
  ].join("\n");
}

async function main() {
  const check = process.argv.includes("--check");
  const { raw, path, fetched } = await loadSpec(specArgument());
  const spec = JSON.parse(raw.toString("utf-8"));
  const digest = sha256(raw);
  const version = spec.info?.version ?? "unknown";
  const operationCount = documentOperationCount(spec);
  const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
  const label = fetched ? DEFAULT_SOURCE : path;

  if (check) {
    const problems = [];
    if (runAppScript("generate-sdk-types.mjs", raw, ["--check"]) !== 0) {
      problems.push("src/schema.ts or its src/index.ts export block is stale");
    }
    const committed = readProvenance(readIfExists(provenancePath) ?? "");
    if (
      committed.sha256 !== digest ||
      committed.version !== version ||
      committed.operationCount !== operationCount
    ) {
      problems.push(
        `src/provenance.ts names sha256 ${committed.sha256 ?? "(none)"}, the document is ${digest}`,
      );
    }
    if (problems.length > 0) {
      console.error(`generate: ${problems.join("; ")} against ${label}.`);
      console.error(
        fetched
          ? "  The published document changed. Run: npm run generate"
          : `  Run: node scripts/generate.mjs --spec ${path}`,
      );
      process.exit(1);
    }
    console.log(
      `generate: OK (${schemaCount} schemas, ${operationCount} operations, sha256 ${digest}) against ${label}`,
    );
    return;
  }

  // Same bytes as the recorded document: keep its source and its resolved app
  // commit, so a rebuild from the snapshot is byte-identical and needs no
  // network. APP_COMMIT still overrides, and an unresolved commit is retried.
  const previous = readProvenance(readIfExists(provenancePath) ?? "");
  const sameDocument = previous.sha256 === digest;
  const source =
    sameDocument && previous.source
      ? previous.source
      : fetched
        ? DEFAULT_SOURCE
        : `${APP_REPOSITORY}:${APP_SPEC_PATH}`;
  const appCommit =
    sameDocument && previous.appCommit && !process.env.APP_COMMIT
      ? previous.appCommit
      : await resolveAppCommit();

  const written = ["src/schema.ts", "src/index.ts schema exports", "src/provenance.ts"];
  if (path !== snapshotPath) {
    writeFileSync(snapshotPath, raw);
    written.unshift("openapi.json");
  }
  if (runAppScript("generate-sdk-types.mjs", raw) !== 0) {
    throw new Error("scripts/app/generate-sdk-types.mjs failed; contract types and exports were not written");
  }
  writeFileSync(
    provenancePath,
    renderProvenance({ source, sha256: digest, version, operationCount, appCommit }),
    "utf-8",
  );
  console.log(
    `generate: wrote ${written.join(", ")} (${schemaCount} schemas, ${operationCount} operations, sha256 ${digest}, app commit ${appCommit ?? "unresolved"})`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`generate: ${error.message}`);
    process.exit(1);
  });
}
