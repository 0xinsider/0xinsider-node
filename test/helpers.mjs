// Shared fixtures for the node:test suites. The suites import the BUILT
// package (dist/), so they test what npm ships.

/** A JSON response the way the API answers one. */
export function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The V1 error envelope. */
export function apiError(code, message, extra = {}) {
  return {
    object: "error",
    error: { code, message, ...extra },
    meta: { request_id: "req_test", cached: false, cost: 0 },
  };
}

/** A list envelope page. */
export function listPage(data, { hasMore = false, nextCursor = null } = {}) {
  return {
    object: "list",
    data,
    has_more: hasMore,
    next_cursor: nextCursor,
    meta: { request_id: "req_test", cached: false, cost: 1 },
  };
}

/**
 * A fetch double. `handler(url, init, callIndex)` returns a Response (or a
 * promise of one); every call is recorded on `.calls` as { url, init }.
 */
export function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** A 200 text/event-stream response whose body delivers `chunks` in order. */
export function sseResponse(chunks, { contentType = "text/event-stream", status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": contentType } });
}

/** Header lookup that works on a Headers instance or a plain record. */
export function header(init, name) {
  const headers = init.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : headers[key];
}
