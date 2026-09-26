#!/usr/bin/env node
// Assert the published SDK's operation table matches the public OpenAPI
// contract, and that the stdio MCP package registers every tool the remote MCP
// surface exposes (#9687).
//
// WHY THIS IS A SCRIPT, NOT A TEST. `sdk/src/client.ts` calls its table "kept
// in lockstep with web/public/api/v1/openapi.json by the drift test" -- but the
// repository does not run test suites (AGENTS.md, "Verification policy"), and
// no CI job invokes vitest. The declared enforcement therefore could not fire,
// and the SDK silently shipped three operations short of the spec. This is the
// same comparison as an executable check that any agent or human can run.
//
// Usage: node scripts/check-sdk-openapi-drift.mjs
// Exits 0 when the surfaces agree, 1 with a diff when they do not.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = resolve(repoRoot, "web/public/api/v1/openapi.json");
const clientPath = resolve(repoRoot, "sdk/src/client.ts");

const HTTP_METHODS = new Set(["get", "post", "patch", "delete", "put"]);

/**
 * Every published operation, partitioned by what it answers on success
 * (#16137).
 *
 * This used to be "operations with a documented 200", which silently dropped
 * four published routes: `registerAgent` answers `201`, the export download
 * and the spec redirect answer `302`/`307`, and the MCP GET answers `405` by
 * design. Three of them then had no SDK method and nothing failed. Now every
 * operation with an `operationId` lands in exactly one bucket and the client
 * must declare it in the matching table.
 */
function specOperations() {
  const spec = JSON.parse(readFileSync(specPath, "utf-8"));
  const schemas = spec.components?.schemas ?? {};
  const success = new Map();
  const redirect = new Map();
  const other = new Map();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation.operationId) continue;
      const statuses = Object.keys(operation.responses ?? {}).sort();
      const successStatus = statuses.find((status) => status.startsWith("2"));
      const redirectStatus = statuses.find((status) => status.startsWith("3"));
      const row = { path, method, operation };
      if (successStatus) {
        row.status = successStatus;
        row.kind = responseKind(operation, statuses, schemas);
        success.set(operation.operationId, row);
      } else if (redirectStatus) {
        row.status = redirectStatus;
        redirect.set(operation.operationId, row);
      } else {
        other.set(operation.operationId, row);
      }
    }
  }
  return { success, redirect, other };
}

/**
 * The `kind` an operation's success body implies, matching the union in
 * `sdk/src/client.ts`. The first 2xx that declares content decides it, since
 * a `202` with no body (an MCP notification) describes the same transport as
 * the `200` beside it.
 */
function responseKind(operation, statuses, schemas) {
  const withBody = statuses
    .filter((status) => status.startsWith("2"))
    .find((status) => Object.keys(operation.responses[status].content ?? {}).length > 0);
  if (!withBody) return "envelope";
  const content = operation.responses[withBody].content;
  const media = Object.keys(content);
  if (media.includes("text/event-stream")) return "sse";
  if (media.every((type) => type.startsWith("text/"))) return "text";
  const json = content["application/json"];
  const schema = json?.schema?.$ref
    ? schemas[json.schema.$ref.replace("#/components/schemas/", "")]
    : json?.schema;
  if (schema?.properties?.jsonrpc) return "jsonrpc";
  return "envelope";
}

/**
 * The rows of one `export const NAME = [ ... ] as const` table in the client.
 *
 * Read as text rather than imported: this script must run against the source
 * tree with no build step and no dependency on the package being compiled.
 * Braces inside string literals (`/api/v1/trader/{address}`) are masked
 * first, so a row can be matched as a brace-delimited object.
 */
function sdkTableRows(source, name) {
  const start = source.indexOf(`export const ${name} = [`);
  if (start === -1) {
    throw new Error(`sdk/src/client.ts no longer declares ${name}`);
  }
  const end = source.indexOf("\n] as const", start);
  if (end === -1) {
    throw new Error(`sdk/src/client.ts: ${name} has no "] as const" terminator`);
  }
  const block = source
    .slice(start, end)
    .replace(/"(?:[^"\\]|\\.)*"/g, (literal) =>
      literal.replace(/\{/g, "\u0001").replace(/\}/g, "\u0002"),
    );
  const rows = new Map();
  for (const match of block.matchAll(/\{[^{}]*\}/g)) {
    const body = match[0].replace(/\u0001/g, "{").replace(/\u0002/g, "}");
    const id = /operationId:\s*"([^"]+)"/.exec(body);
    if (!id) continue;
    const kind = /\bkind:\s*"([^"]+)"/.exec(body);
    const method = /\bmethod:\s*"([^"]+)"/.exec(body);
    const path = /\bpath:\s*"([^"]+)"/.exec(body);
    const status = /\bstatus:\s*(\d+)/.exec(body);
    rows.set(id[1], {
      kind: kind ? kind[1] : "envelope",
      method: method ? method[1] : undefined,
      path: path ? path[1] : undefined,
      status: status ? status[1] : undefined,
    });
  }
  return rows;
}

/**
 * The generated types must be current (#14278).
 *
 * Operation-id equality was the whole of this check, which is why 78 of the
 * 101 component schemas could have no TypeScript spelling and 24 convenience
 * methods could return `unknown` without anything failing. Regenerating and
 * comparing closes that: a spec change that nobody regenerated fails here.
 */
function checkGeneratedTypes() {
  const generator = resolve(repoRoot, "scripts/generate-sdk-types.mjs");
  const result = spawnSync(process.execPath, [generator, "--check"], {
    encoding: "utf-8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    return false;
  }
  return true;
}

/**
 * Every documented query parameter must have a typed spelling somewhere in the
 * client, whether on a hand-written params interface or through
 * `OperationQuery`. 29 of 117 had none when this was written.
 */
function missingQueryParameters() {
  const spec = JSON.parse(readFileSync(specPath, "utf-8"));
  const source = readFileSync(clientPath, "utf-8");
  const generated = readFileSync(resolve(repoRoot, "sdk/src/schema.ts"), "utf-8");
  const haystack = `${source}\n${generated}`;
  const missing = [];
  for (const [, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation?.operationId) continue;
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== "query") continue;
        const spelling = new RegExp(`^\\s*"?${parameter.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\??:`, "m");
        if (!spelling.test(haystack)) {
          missing.push(`${operation.operationId} -> ${parameter.name}`);
        }
      }
    }
  }
  return [...new Set(missing)].sort();
}

/**
 * The operations that declare an `Idempotency-Key` header parameter, inline
 * or through `components.parameters`. `IDEMPOTENT_WRITE_OPERATIONS` in the
 * client must equal this set: it decides which writes the SDK retries and
 * which keys it refuses, so a route gaining or losing the header without the
 * SDK following is a retry-safety bug, not a typing gap (#16182).
 */
function specIdempotentOperationIds() {
  const spec = JSON.parse(readFileSync(specPath, "utf-8"));
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
  for (const [, methods] of Object.entries(spec.paths ?? {})) {
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
    throw new Error("sdk/src/client.ts no longer declares IDEMPOTENT_WRITE_OPERATIONS");
  }
  return new Set([...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

const typesCurrent = checkGeneratedTypes();
const missingParameters = missingQueryParameters();
const specIdempotent = specIdempotentOperationIds();
const sdkIdempotent = sdkIdempotentOperationIds();
const idempotentMissingFromSdk = [...specIdempotent].filter((id) => !sdkIdempotent.has(id)).sort();
const idempotentMissingFromSpec = [...sdkIdempotent].filter((id) => !specIdempotent.has(id)).sort();

const clientSource = readFileSync(clientPath, "utf-8");
const { success: spec, redirect: specRedirect, other: specOther } = specOperations();
const sdk = sdkTableRows(clientSource, "API_CLIENT_OPERATIONS");
const sdkRedirect = sdkTableRows(clientSource, "REDIRECT_OPERATIONS");
const sdkUnsupported = sdkTableRows(clientSource, "UNSUPPORTED_OPERATIONS");

const missingFromSdk = [...spec.keys()].filter((id) => !sdk.has(id)).sort();
const missingFromSpec = [...sdk.keys()].filter((id) => !spec.has(id)).sort();
/** A row whose declared `kind` is not what its success body actually is. */
const wrongKind = [...spec.entries()]
  .filter(([id, row]) => sdk.has(id) && sdk.get(id).kind !== row.kind)
  .map(([id, row]) => `${id}: spec answers ${row.kind}, the SDK row says ${sdk.get(id).kind}`)
  .sort();
const redirectMissingFromSdk = [...specRedirect.keys()].filter((id) => !sdkRedirect.has(id)).sort();
const redirectMissingFromSpec = [...sdkRedirect.keys()].filter((id) => !specRedirect.has(id)).sort();
/**
 * A redirect row that kept its operationId while the spec moved its method,
 * path or status (#16686): the SDK would still call the old path or accept
 * only the old status, so the ids alone are not lockstep.
 */
const redirectMismatch = [...specRedirect.entries()]
  .filter(([id]) => sdkRedirect.has(id))
  .flatMap(([id, row]) => {
    const sdkRow = sdkRedirect.get(id);
    const diffs = [];
    if (sdkRow.method !== row.method.toUpperCase()) diffs.push(`method ${sdkRow.method} vs spec ${row.method.toUpperCase()}`);
    if (sdkRow.path !== row.path) diffs.push(`path ${sdkRow.path} vs spec ${row.path}`);
    if (sdkRow.status !== row.status) diffs.push(`status ${sdkRow.status} vs spec ${row.status}`);
    return diffs.length === 0 ? [] : [`${id}: ${diffs.join("; ")}`];
  })
  .sort();
const unsupportedMissingFromSdk = [...specOther.keys()].filter((id) => !sdkUnsupported.has(id)).sort();
const unsupportedMissingFromSpec = [...sdkUnsupported.keys()].filter((id) => !specOther.has(id)).sort();

if (
  missingFromSdk.length === 0 &&
  missingFromSpec.length === 0 &&
  wrongKind.length === 0 &&
  redirectMissingFromSdk.length === 0 &&
  redirectMissingFromSpec.length === 0 &&
  redirectMismatch.length === 0 &&
  unsupportedMissingFromSdk.length === 0 &&
  unsupportedMissingFromSpec.length === 0 &&
  missingParameters.length === 0 &&
  idempotentMissingFromSdk.length === 0 &&
  idempotentMissingFromSpec.length === 0 &&
  typesCurrent
) {
  console.log(
    `check-sdk-openapi-drift: OK (${spec.size} operations agree between the OpenAPI spec and the SDK table, each with the response kind its body declares; ${specRedirect.size} redirect and ${specOther.size} unsupported operation(s) declared; every documented query parameter has a typed spelling; ${specIdempotent.size} Idempotency-Key operations agree).`,
  );
  process.exit(0);
}

if (wrongKind.length > 0) {
  console.error(
    `check-sdk-openapi-drift: ${wrongKind.length} operation(s) declare the wrong response kind in sdk/src/client.ts:`,
  );
  for (const entry of wrongKind) console.error(`  - ${entry}`);
}
if (redirectMismatch.length > 0) {
  console.error(
    "check-sdk-openapi-drift: REDIRECT_OPERATIONS rows in sdk/src/client.ts disagree with the spec's method, path or redirect status:",
  );
  for (const entry of redirectMismatch) console.error(`  - ${entry}`);
}
if (redirectMissingFromSdk.length > 0 || redirectMissingFromSpec.length > 0) {
  console.error(
    "check-sdk-openapi-drift: REDIRECT_OPERATIONS in sdk/src/client.ts does not match the redirect-only operations in the OpenAPI spec:",
  );
  for (const id of redirectMissingFromSdk) console.error(`  - in the spec, not in the SDK: ${id}`);
  for (const id of redirectMissingFromSpec) console.error(`  - in the SDK, not in the spec: ${id}`);
}
if (unsupportedMissingFromSdk.length > 0 || unsupportedMissingFromSpec.length > 0) {
  console.error(
    "check-sdk-openapi-drift: UNSUPPORTED_OPERATIONS in sdk/src/client.ts does not match the operations with no documented success or redirect response:",
  );
  for (const id of unsupportedMissingFromSdk) console.error(`  - in the spec, not in the SDK: ${id}`);
  for (const id of unsupportedMissingFromSpec) console.error(`  - in the SDK, not in the spec: ${id}`);
}

if (idempotentMissingFromSdk.length > 0 || idempotentMissingFromSpec.length > 0) {
  console.error(
    "check-sdk-openapi-drift: IDEMPOTENT_WRITE_OPERATIONS in sdk/src/client.ts does not match the operations declaring Idempotency-Key in the OpenAPI spec:",
  );
  for (const id of idempotentMissingFromSdk) console.error(`  - in the spec, not in the SDK: ${id}`);
  for (const id of idempotentMissingFromSpec) console.error(`  - in the SDK, not in the spec: ${id}`);
}

if (missingParameters.length > 0) {
  console.error(
    `check-sdk-openapi-drift: ${missingParameters.length} documented query parameter(s) have no typed spelling in the SDK:`,
  );
  for (const entry of missingParameters) console.error(`  - ${entry}`);
}

if (missingFromSdk.length > 0) {
  console.error(
    `check-sdk-openapi-drift: ${missingFromSdk.length} operation(s) in the OpenAPI spec are missing from sdk/src/client.ts:`,
  );
  for (const id of missingFromSdk) console.error(`  - ${id}`);
}
if (missingFromSpec.length > 0) {
  console.error(
    `check-sdk-openapi-drift: ${missingFromSpec.length} operation(s) in sdk/src/client.ts are absent from the OpenAPI spec:`,
  );
  for (const id of missingFromSpec) console.error(`  - ${id}`);
}
process.exit(1);
