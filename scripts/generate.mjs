#!/usr/bin/env node
// Generate the SDK's contract types (src/schema.ts) and release provenance
// (src/provenance.ts) from the published 0xinsider OpenAPI document, and keep
// the exact document bytes they came from in openapi.json.
//
//   node scripts/generate.mjs                        # fetch https://0xinsider.com/api/v1/openapi.json
//   node scripts/generate.mjs --spec openapi.json    # regenerate from the committed snapshot
//   SPEC=path/to/openapi.json node scripts/generate.mjs
//   APP_COMMIT=<sha> node scripts/generate.mjs       # the 0xinsider/0xinsider commit the document belongs to
//   node scripts/generate.mjs --check [--spec ...]   # exit 1 if the committed files are stale
//
// WHY A HAND-ROLLED GENERATOR. The document is small and regular: nearly every
// schema is `type` + `properties` + `required`, with a handful of enums and
// `allOf` / `oneOf` / `additionalProperties`. A dependency such as
// openapi-typescript would add a supply chain for a job the standard library
// does. The tradeoff is that this file must understand every construct the
// document uses, so it THROWS on one it does not rather than emitting
// `unknown` and hiding the gap.
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
// --check regenerates in memory and compares: src/schema.ts must equal the
// rendering, and src/provenance.ts must name the same document (SHA-256,
// version, operation count). Against the live document (the default source)
// that answers "is this release behind the API"; against --spec openapi.json it
// answers "are the committed files generated from the committed snapshot".

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE = "https://0xinsider.com/api/v1/openapi.json";
export const APP_REPOSITORY = "0xinsider/0xinsider";
export const APP_SPEC_PATH = "web/public/api/v1/openapi.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(repoRoot, "openapi.json");
const schemaPath = resolve(repoRoot, "src/schema.ts");
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

/** A property name that is not a bare identifier has to be quoted. */
function propertyKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/** Render src/schema.ts for one parsed document. Throws on a construct it cannot type. */
export function renderSchema(spec) {
  const schemas = spec.components?.schemas ?? {};

  /** `#/components/schemas/Trader` -> `Trader`, and nothing else resolves. */
  function refName(ref) {
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) {
      throw new Error(`unsupported $ref outside components.schemas: ${ref}`);
    }
    const name = ref.slice(prefix.length);
    if (!(name in schemas)) {
      throw new Error(`$ref names a schema the document does not define: ${ref}`);
    }
    return name;
  }

  /**
   * One schema as a TypeScript type expression.
   *
   * `depth` only shapes indentation. Every branch either produces a type or
   * throws: an unhandled construct is a generator gap to fix, never an
   * `unknown` to ship.
   */
  function typeOf(schema, depth, path) {
    if (schema === true) return "unknown";
    if (!schema || typeof schema !== "object") {
      throw new Error(`${path}: not a schema object`);
    }
    if (schema.$ref) return refName(schema.$ref);

    // `const` is how the document spells a discriminant ("object": "trader").
    if (schema.const !== undefined) return quote(schema.const);

    if (schema.enum) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
        throw new Error(`${path}: empty enum`);
      }
      const type = schema.enum.map(quote).join(" | ");
      // Enum schemas take this branch before scalar nullability is handled.
      return schema.nullable === true ? `${type} | null` : type;
    }

    if (schema.oneOf || schema.anyOf) {
      const members = schema.oneOf ?? schema.anyOf;
      return members
        .map((member, index) => typeOf(member, depth, `${path}/${index}`))
        .join(" | ");
    }

    if (schema.allOf) {
      return schema.allOf
        .map((member, index) => typeOf(member, depth, `${path}/${index}`))
        .join(" & ");
    }

    // OpenAPI 3.1 spells nullability as a type ARRAY (`["integer","null"]`);
    // 3.0 spells it `nullable: true`. The document uses both, so both are read
    // and normalized to one `| null` here.
    let type = schema.type;
    let nullable = schema.nullable === true;
    if (Array.isArray(type)) {
      const members = type.filter((member) => member !== "null");
      if (members.length !== type.length) nullable = true;
      if (members.length !== 1) {
        throw new Error(`${path}: type array with ${members.length} non-null members`);
      }
      [type] = members;
    }
    const wrap = (inner) => (nullable ? `${inner} | null` : inner);

    switch (type) {
      case "string":
        return wrap("string");
      case "integer":
      case "number":
        return wrap("number");
      case "boolean":
        return wrap("boolean");
      case "null":
        return "null";
      case "array": {
        // `{"type": "array"}` with no `items` is how the document spells "any
        // JSON array", in the JSON-RPC error payload. It is a real declaration,
        // not an omission, so it types as an open array rather than throwing.
        if (!schema.items) return wrap("unknown[]");
        const item = typeOf(schema.items, depth, `${path}/items`);
        // Parenthesize a union so `A | B[]` cannot be read as `A | (B[])`.
        const needsParens = /[|&]/.test(item);
        return wrap(needsParens ? `(${item})[]` : `${item}[]`);
      }
      case "object":
      case undefined: {
        if (schema.properties) return wrap(objectBody(schema, depth, path));
        if (schema.additionalProperties) {
          const value =
            schema.additionalProperties === true
              ? "unknown"
              : typeOf(schema.additionalProperties, depth, `${path}/additionalProperties`);
          return wrap(`Record<string, ${value}>`);
        }
        // A bare `{"type": "object"}` really is an open object here.
        if (type === "object") return wrap("Record<string, unknown>");
        // A schema carrying only annotations is JSON Schema's "any value", and
        // the document uses it deliberately for pass-through provider payloads
        // (`RadarFlag.evidence`). `unknown` is the honest spelling, and it is
        // reached only here, by an explicit decision -- everything else throws.
        const ANNOTATION_KEYS = new Set(["description", "title", "example", "examples", "deprecated", "default"]);
        if (Object.keys(schema).every((key) => ANNOTATION_KEYS.has(key))) {
          return wrap("unknown");
        }
        throw new Error(`${path}: schema with no type, properties, $ref or composition`);
      }
      default:
        throw new Error(`${path}: unhandled type ${quote(type)}`);
    }
  }

  function objectBody(schema, depth, path) {
    const required = new Set(schema.required ?? []);
    const pad = "  ".repeat(depth + 1);
    const closePad = "  ".repeat(depth);
    const lines = [];
    for (const [name, property] of Object.entries(schema.properties)) {
      const optional = required.has(name) ? "" : "?";
      const type = typeOf(property, depth + 1, `${path}/${name}`);
      if (property.description) {
        lines.push(`${pad}/** ${property.description.replace(/\s+/g, " ").trim()} */`);
      }
      lines.push(`${pad}${propertyKey(name)}${optional}: ${type};`);
    }
    return `{\n${lines.join("\n")}\n${closePad}}`;
  }

  /**
   * The type of an operation's `data`, which is what `ApiClient.call<T>` returns.
   *
   * A 200 that is not a JSON envelope (the document has none today) throws
   * rather than degrading to `unknown`.
   */
  function dataType({ operation }) {
    const content = operation.responses["200"].content;
    const json = content?.["application/json"];
    if (!json?.schema) {
      // Two operations answer a non-JSON body and are not envelopes at all:
      // the Markdown context documents (text/markdown) and the SSE stream
      // `getStream` (text/event-stream). A caller reads those through
      // `stream.ts` or as text, so `string` is the payload, and saying so beats
      // both `unknown` and a throw.
      const mediaTypes = Object.keys(content ?? {});
      const textual = mediaTypes.every(
        (media) => media.startsWith("text/") || media === "application/x-ndjson",
      );
      if (mediaTypes.length > 0 && textual) return "string";
      throw new Error(
        `${operation.operationId}: 200 has no application/json schema and is not a text body (${mediaTypes.join(", ") || "no content"})`,
      );
    }
    const schema = json.schema.$ref ? schemas[refName(json.schema.$ref)] : json.schema;
    const data = schema.properties?.data;
    if (!data) {
      // Not an envelope: the payload IS the body.
      return typeOf(json.schema, 1, `${operation.operationId}/200`);
    }
    return typeOf(data, 1, `${operation.operationId}/200/data`);
  }

  /** Path parameters, typed as the document declares them (a webhook `id` is an integer). */
  function pathType({ operation }) {
    const params = (operation.parameters ?? []).filter((p) => p.in === "path");
    if (params.length === 0) return "Record<string, never>";
    const lines = params.map((p) => {
      const type = typeOf(p.schema, 2, `${operation.operationId}/path/${p.name}`);
      const doc = p.description
        ? `    /** ${p.description.replace(/\s+/g, " ").trim()} */\n`
        : "";
      return `${doc}    ${propertyKey(p.name)}: ${type};`;
    });
    return `{\n${lines.join("\n")}\n  }`;
  }

  /**
   * The JSON request body, or `never` for an operation that takes none. Every
   * body the document declares is `required: true`, so a declared body is a
   * required argument; a `required: false` body would need a second marker
   * here, and the throw says so rather than guessing.
   */
  function bodyType({ operation }) {
    const body = operation.requestBody;
    if (!body) return "never";
    if (body.required !== true) {
      throw new Error(
        `${operation.operationId}: requestBody is not required: true; OperationBody has no spelling for an optional body`,
      );
    }
    const json = body.content?.["application/json"];
    if (!json?.schema) {
      throw new Error(`${operation.operationId}: requestBody has no application/json schema`);
    }
    return typeOf(json.schema, 1, `${operation.operationId}/requestBody`);
  }

  /**
   * The whole 200 body: the envelope with its own `object` literal, `meta`
   * type and any extra top-level fields (`has_more`, `next_cursor`,
   * `computed_at`, a list's `market` and `totals`), with `data` spelled as
   * `OperationData[id]` so the two interfaces cannot disagree. A text body is
   * `string`, as in `OperationData`.
   */
  function responseType({ operation }) {
    const content = operation.responses["200"].content;
    const json = content?.["application/json"];
    if (!json?.schema) return dataType({ operation });
    if (json.schema.$ref) return refName(json.schema.$ref);
    const schema = json.schema;
    if (!schema.properties?.data) {
      return typeOf(schema, 1, `${operation.operationId}/200`);
    }
    const required = new Set(schema.required ?? []);
    const lines = [];
    for (const [name, property] of Object.entries(schema.properties)) {
      const optional = required.has(name) ? "" : "?";
      const type =
        name === "data"
          ? `OperationData[${quote(operation.operationId)}]`
          : typeOf(property, 2, `${operation.operationId}/200/${name}`);
      if (property.description) {
        lines.push(`    /** ${property.description.replace(/\s+/g, " ").trim()} */`);
      }
      lines.push(`    ${propertyKey(name)}${optional}: ${type};`);
    }
    return `{\n${lines.join("\n")}\n  }`;
  }

  /** Query parameters only. Path and header parameters are the caller's other arguments. */
  function queryType({ operation }) {
    const params = (operation.parameters ?? []).filter((p) => p.in === "query");
    if (params.length === 0) return "Record<string, never>";
    const lines = params.map((p) => {
      const optional = p.required ? "" : "?";
      const type = typeOf(p.schema, 2, `${operation.operationId}/query/${p.name}`);
      const doc = p.description
        ? `    /** ${p.description.replace(/\s+/g, " ").trim()} */\n`
        : "";
      return `${doc}    ${propertyKey(p.name)}${optional}: ${type};`;
    });
    return `{\n${lines.join("\n")}\n  }`;
  }

  const out = [];
  out.push("// GENERATED by scripts/generate.mjs from the published 0xinsider OpenAPI");
  out.push("// document (https://0xinsider.com/api/v1/openapi.json, snapshot in");
  out.push("// openapi.json). Do not edit by hand: `npm run check` regenerates this file");
  out.push("// and fails on a difference.");
  out.push("//");
  out.push(`// Source contract version: ${spec.info?.version ?? "unknown"}`);
  out.push("");

  for (const [name, schema] of Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) {
    if (schema.description) {
      out.push(`/** ${schema.description.replace(/\s+/g, " ").trim()} */`);
    }
    out.push(`export type ${name} = ${typeOf(schema, 0, `#/components/schemas/${name}`)};`);
    out.push("");
  }

  const ops = envelopeOperations(spec);

  out.push("/**");
  out.push(" * The `data` payload each operation answers with: what");
  out.push(" * `ApiClient.call<T>` resolves to, and the default `T` of every");
  out.push(" * convenience method.");
  out.push(" */");
  out.push("export interface OperationData {");
  for (const op of ops) {
    out.push(`  ${propertyKey(op.operation.operationId)}: ${dataType(op)};`);
  }
  out.push("}");
  out.push("");

  out.push("/** Each operation's documented query parameters. */");
  out.push("export interface OperationQuery {");
  for (const op of ops) {
    out.push(`  ${propertyKey(op.operation.operationId)}: ${queryType(op)};`);
  }
  out.push("}");
  out.push("");

  out.push("/** Each operation's path parameters; `Record<string, never>` when the path has none. */");
  out.push("export interface OperationPath {");
  for (const op of ops) {
    out.push(`  ${propertyKey(op.operation.operationId)}: ${pathType(op)};`);
  }
  out.push("}");
  out.push("");

  out.push("/** Each operation's JSON request body; `never` when it takes none. */");
  out.push("export interface OperationBody {");
  for (const op of ops) {
    out.push(`  ${propertyKey(op.operation.operationId)}: ${bodyType(op)};`);
  }
  out.push("}");
  out.push("");

  out.push("/**");
  out.push(" * The whole 200 body of each operation: the envelope with its own `object`");
  out.push(" * literal, `meta` type and top-level fields, `data` as `OperationData[id]`;");
  out.push(" * `string` for a text body. What `ApiClient.call(id)` resolves to.");
  out.push(" */");
  out.push("export interface OperationResponse {");
  for (const op of ops) {
    out.push(`  ${propertyKey(op.operation.operationId)}: ${responseType(op)};`);
  }
  out.push("}");
  out.push("");

  return out.join("\n");
}

/** Every operation with a documented 200, sorted by operationId: the SDK's table. */
export function envelopeOperations(spec) {
  const found = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation?.responses?.["200"]) continue;
      if (!operation.operationId) continue;
      found.push({ path, method, operation });
    }
  }
  found.sort((a, b) => a.operation.operationId.localeCompare(b.operation.operationId));
  return found;
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
  const rendered = renderSchema(spec);
  const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
  const label = fetched ? DEFAULT_SOURCE : path;

  if (check) {
    const problems = [];
    if (readIfExists(schemaPath) !== rendered) {
      problems.push("src/schema.ts is stale");
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

  const written = ["src/schema.ts", "src/provenance.ts"];
  if (path !== snapshotPath) {
    writeFileSync(snapshotPath, raw);
    written.unshift("openapi.json");
  }
  writeFileSync(schemaPath, rendered, "utf-8");
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
