#!/usr/bin/env node
// Generate the TypeScript SDK's types from the public OpenAPI contract
// (#14278).
//
// WHY A GENERATOR, AND WHY THIS ONE. `sdk/` was hand-written: 78 of the 101
// component schemas had no TypeScript spelling, 24 convenience methods declared
// `<T = unknown>`, and the drift gate compared only `operationId` sets, so none
// of that could fail a check. The Go and Python clients shipped generated from
// this same document on 2026-09-14 and regenerate weekly, which left the
// TypeScript caller -- the one the MCP server, the web app and every README
// example is written for -- getting `unknown` back.
//
// It is hand-rolled rather than `openapi-typescript` because this document is
// ours and small: 99 of its 101 schemas are `type` + `properties` + `required`,
// with 5 enums and a handful of `allOf` / `oneOf` / `additionalProperties`
// (counted 2026-09-18). A dependency would add an `sdk/` lockfile, an audit
// leg and a supply chain for a job the standard library does. The tradeoff is
// that this file must understand every construct the spec uses -- so it THROWS
// on one it does not, rather than emitting `unknown` and hiding the gap the
// way the hand-written types did.
//
// Usage:
//   node scripts/generate-sdk-types.mjs           # write sdk/src/schema.ts
//   node scripts/generate-sdk-types.mjs --check   # exit 1 if the file is stale
//
// `check-sdk-openapi-drift.mjs` runs the --check form, so a spec change that
// is not regenerated fails the gate.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = resolve(repoRoot, "web/public/api/v1/openapi.json");
const outPath = resolve(repoRoot, "sdk/src/schema.ts");

const HTTP_METHODS = new Set(["get", "post", "patch", "delete", "put"]);

const spec = JSON.parse(readFileSync(specPath, "utf-8"));
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

function quote(value) {
  return JSON.stringify(value);
}

/** A property name that is not a bare identifier has to be quoted. */
function propertyKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/**
 * One schema as a TypeScript type expression.
 *
 * `depth` only shapes indentation. Every branch either produces a type or
 * throws: an unhandled construct is a generator gap to fix, never an `unknown`
 * to ship.
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
  // 3.0 spells it `nullable: true`. This document uses both, so both are read
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
      // (`RadarFlag.evidence` is the stored `whale_alerts.suspicion_signals`).
      // `unknown` is the honest spelling, and it is reached only here, by an
      // explicit decision -- everything else throws.
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
 * The status an operation answers on success, lowest documented 2xx first.
 *
 * Not every published operation answers 200: `registerAgent` mints a sandbox
 * key and answers `201` only, and reading its envelope as "no success
 * response" is what kept it out of the generated types and out of the SDK's
 * operation table (#16137). A 3xx (the export download's 302, the spec
 * redirect's 307) is NOT a success body: those carry a `Location` and no
 * schema, and `sdk/src/client.ts` declares them in `REDIRECT_OPERATIONS`
 * with the method that follows them.
 */
const SUCCESS_STATUSES = ["200", "201", "202", "203", "204"];
function successStatus(operation) {
  return SUCCESS_STATUSES.find((status) => operation?.responses?.[status]);
}

/** Every operation with a documented 2xx, in document order. */
function operations() {
  const found = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!successStatus(operation)) continue;
      if (!operation.operationId) continue;
      found.push({ path, method, operation });
    }
  }
  found.sort((a, b) => a.operation.operationId.localeCompare(b.operation.operationId));
  return found;
}

/**
 * The type of an operation's `data`, which is what `ApiClient.call<T>` returns.
 *
 * A success body that is not a JSON envelope (the document has none today)
 * throws rather than degrading to `unknown`.
 */
function dataType({ operation }) {
  const content = operation.responses[successStatus(operation)].content;
  const json = content?.["application/json"];
  if (!json?.schema) {
    // Two operations answer a non-JSON body and are not envelopes at all:
    // `getTraderContextMarkdown` (text/markdown) and the SSE stream
    // `getStream` (text/event-stream). A caller reads those through
    // `stream.ts` or as text, so `string` is the payload, and saying so beats
    // both `unknown` and a throw. (`openMcpEventStream` has no 200 since
    // #16354: it answers 405, so the loop above skips it.)
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
 * body the document declares is `required: true` (checked 2026-09-22), so a
 * declared body is a required argument; a `required: false` body would need
 * a second marker here, and the throw says so rather than guessing.
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
 * The whole success body: the envelope with its own `object` literal, `meta`
 * type and any extra top-level fields (`has_more`, `next_cursor`,
 * `computed_at`, a list's `market` and `totals`), with `data` spelled as
 * `OperationData[id]` so the two interfaces cannot disagree. A text body is
 * `string`, as in `OperationData`.
 */
function responseType({ operation }) {
  const content = operation.responses[successStatus(operation)].content;
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

function render() {
  const out = [];
  out.push("// GENERATED by scripts/generate-sdk-types.mjs from");
  out.push("// web/public/api/v1/openapi.json. Do not edit by hand: the drift");
  out.push("// gate regenerates this file and fails on a difference (#14278).");
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

  const ops = operations();

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

const rendered = render();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf-8");
  } catch {
    console.error("generate-sdk-types: sdk/src/schema.ts is missing; run node scripts/generate-sdk-types.mjs");
    process.exit(1);
  }
  if (current !== rendered) {
    console.error(
      "generate-sdk-types: sdk/src/schema.ts is stale against web/public/api/v1/openapi.json.",
    );
    console.error("  Run: node scripts/generate-sdk-types.mjs");
    process.exit(1);
  }
  console.log(
    `generate-sdk-types: OK (${Object.keys(schemas).length} schemas, ${operations().length} operations)`,
  );
  process.exit(0);
}

writeFileSync(outPath, rendered, "utf-8");
console.log(
  `generate-sdk-types: wrote sdk/src/schema.ts (${Object.keys(schemas).length} schemas, ${operations().length} operations)`,
);
