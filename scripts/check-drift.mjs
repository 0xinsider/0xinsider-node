#!/usr/bin/env node
// Assert the SDK matches the OpenAPI document it claims to be generated from.
//
//   node scripts/check-drift.mjs --spec openapi.json   # the committed snapshot (CI, `npm run check`)
//   node scripts/check-drift.mjs                       # the published document (`npm run check:live`)
//
// Four comparisons, each a way the hand-written client can fall behind the
// generated types:
//   1. src/schema.ts and src/provenance.ts are what scripts/generate.mjs
//      renders for this document (`generate.mjs --check`).
//   2. API_CLIENT_OPERATIONS in src/client.ts lists exactly the operations the
//      document answers with a 200.
//   3. Every documented query parameter has a typed spelling in the client or
//      the generated `OperationQuery`.
//   4. IDEMPOTENT_WRITE_OPERATIONS equals the operations that declare an
//      `Idempotency-Key` header: it decides which writes the SDK retries and
//      which keys it refuses, so a route gaining or losing the header without
//      the SDK following is a retry-safety bug, not a typing gap.
//
// Exits 0 when everything agrees, 1 with the differences when it does not.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { envelopeOperations, loadSpec, specArgument } from "./generate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientPath = resolve(repoRoot, "src/client.ts");
const schemaPath = resolve(repoRoot, "src/schema.ts");

const HTTP_METHODS = new Set(["get", "post", "patch", "delete", "put"]);

const { raw, path, fetched } = await loadSpec(specArgument());
const spec = JSON.parse(raw.toString("utf-8"));
const label = fetched ? "the published OpenAPI document" : path;

/**
 * Run the generator's --check on the SAME bytes this script loaded, so a
 * document that changes between two fetches cannot make the checks disagree.
 */
function checkGeneratedFiles() {
  let specFile = path;
  let scratch;
  if (!specFile) {
    scratch = mkdtempSync(join(tmpdir(), "oxinsider-drift-"));
    specFile = join(scratch, "openapi.json");
    writeFileSync(specFile, raw);
  }
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/generate.mjs"), "--check", "--spec", specFile],
      { encoding: "utf-8" },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      return false;
    }
    return true;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Operations the document publishes with a 200: the SDK table's contract. */
function specOperationIds() {
  return new Set(envelopeOperations(spec).map(({ operation }) => operation.operationId));
}

/**
 * Operation ids the SDK table declares. Read as text rather than imported, so
 * this runs against the source tree with no build step.
 */
function sdkOperationIds() {
  const source = readFileSync(clientPath, "utf-8");
  const ids = new Set();
  for (const match of source.matchAll(/operationId:\s*"([^"]+)"/g)) {
    ids.add(match[1]);
  }
  return ids;
}

/** Documented query parameters with no typed spelling in the client or the generated types. */
function missingQueryParameters() {
  const haystack = `${readFileSync(clientPath, "utf-8")}\n${readFileSync(schemaPath, "utf-8")}`;
  const missing = [];
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation?.operationId) continue;
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== "query") continue;
        const escaped = parameter.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const spelling = new RegExp(`^\\s*"?${escaped}"?\\??:`, "m");
        if (!spelling.test(haystack)) {
          missing.push(`${operation.operationId} -> ${parameter.name}`);
        }
      }
    }
  }
  return [...new Set(missing)].sort();
}

/** The operations declaring an `Idempotency-Key` header, inline or through components.parameters. */
function specIdempotentOperationIds() {
  const shared = spec.components?.parameters ?? {};
  const declaresKey = (parameter) => {
    const resolved = parameter?.$ref
      ? shared[parameter.$ref.replace("#/components/parameters/", "")]
      : parameter;
    return (
      resolved?.in === "header" &&
      typeof resolved.name === "string" &&
      resolved.name.toLowerCase() === "idempotency-key"
    );
  };
  const ids = new Set();
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation?.operationId) continue;
      if ((operation.parameters ?? []).some(declaresKey)) ids.add(operation.operationId);
    }
  }
  return ids;
}

/** The ids inside the client's `IDEMPOTENT_WRITE_OPERATIONS = [ ... ]` literal. */
function sdkIdempotentOperationIds() {
  const source = readFileSync(clientPath, "utf-8");
  const literal = source.match(/IDEMPOTENT_WRITE_OPERATIONS = \[([^\]]*)\]/);
  if (!literal) {
    throw new Error("src/client.ts no longer declares IDEMPOTENT_WRITE_OPERATIONS");
  }
  return new Set([...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

const generatedCurrent = checkGeneratedFiles();
const missingParameters = missingQueryParameters();
const specIdempotent = specIdempotentOperationIds();
const sdkIdempotent = sdkIdempotentOperationIds();
const idempotentMissingFromSdk = [...specIdempotent].filter((id) => !sdkIdempotent.has(id)).sort();
const idempotentMissingFromSpec = [...sdkIdempotent].filter((id) => !specIdempotent.has(id)).sort();

const specIds = specOperationIds();
const sdkIds = sdkOperationIds();
const missingFromSdk = [...specIds].filter((id) => !sdkIds.has(id)).sort();
const missingFromSpec = [...sdkIds].filter((id) => !specIds.has(id)).sort();

if (
  generatedCurrent &&
  missingFromSdk.length === 0 &&
  missingFromSpec.length === 0 &&
  missingParameters.length === 0 &&
  idempotentMissingFromSdk.length === 0 &&
  idempotentMissingFromSpec.length === 0
) {
  console.log(
    `check-drift: OK against ${label} (${specIds.size} operations agree with the SDK table; every documented query parameter has a typed spelling; ${specIdempotent.size} Idempotency-Key operations agree).`,
  );
  process.exit(0);
}

if (idempotentMissingFromSdk.length > 0 || idempotentMissingFromSpec.length > 0) {
  console.error(
    `check-drift: IDEMPOTENT_WRITE_OPERATIONS in src/client.ts does not match the operations declaring Idempotency-Key in ${label}:`,
  );
  for (const id of idempotentMissingFromSdk) console.error(`  - in the document, not in the SDK: ${id}`);
  for (const id of idempotentMissingFromSpec) console.error(`  - in the SDK, not in the document: ${id}`);
}
if (missingParameters.length > 0) {
  console.error(
    `check-drift: ${missingParameters.length} documented query parameter(s) have no typed spelling in the SDK:`,
  );
  for (const entry of missingParameters) console.error(`  - ${entry}`);
}
if (missingFromSdk.length > 0) {
  console.error(
    `check-drift: ${missingFromSdk.length} operation(s) in ${label} are missing from API_CLIENT_OPERATIONS in src/client.ts:`,
  );
  for (const id of missingFromSdk) console.error(`  - ${id}`);
}
if (missingFromSpec.length > 0) {
  console.error(
    `check-drift: ${missingFromSpec.length} operation(s) in src/client.ts are absent from ${label}:`,
  );
  for (const id of missingFromSpec) console.error(`  - ${id}`);
}
process.exit(1);
