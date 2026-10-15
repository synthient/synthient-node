import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { APIConnectionError, APIError, APITimeoutError, SynthientError } from "../src/index.ts";
import { json, newClient, problem, serve, stub } from "./helpers.ts";

async function apiError(response: Response): Promise<APIError> {
  const { fetch } = stub(() => response);
  try {
    await newClient({ fetch, maxRetries: 0 }).account();
  } catch (error) {
    assert.ok(error instanceof APIError);
    return error;
  }
  assert.fail("expected an APIError");
}

test("APIError reads problem details", async () => {
  const error = await apiError(
    new Response(
      JSON.stringify({
        type: "https://docs.synthient.com/errors/validation-failed",
        title: "One or more validation errors occurred.",
        status: 422,
        detail: "secret detail\nwith a newline",
        errors: { ip_address: ["Invalid IP address format."] },
        instance: "instance-id",
      }),
      { status: 422, headers: { "x-request-id": "request-id", "retry-after": "3" } },
    ),
  );

  assert.equal(error.status, 422);
  assert.equal(error.type, "https://docs.synthient.com/errors/validation-failed");
  assert.equal(error.title, "One or more validation errors occurred.");
  assert.equal(error.detail, "secret detail\nwith a newline");
  assert.deepEqual(error.errors, { ip_address: ["Invalid IP address format."] });
  assert.equal(error.requestID, "request-id");
  assert.equal(error.retryAfter, 3000);
  assert.equal(error.message, "422 Unprocessable Entity");
  assert.equal(String(error), "APIError: 422 Unprocessable Entity");
});

test("APIError keeps the status for bodies that are not problem details", async () => {
  const bodies = [
    ["401 invalid api key", 401],
    ["<html><body>Bad Gateway</body></html>", 502],
    ["", 500],
    ["{not json", 500],
    ["[1, 2]", 400],
    ['{"title": 5, "errors": ["x"]}', 400],
    ['{"errors": {"ip": [1]}}', 422],
    ["x".repeat(1 << 20), 500],
  ] as const;
  for (const [body, status] of bodies) {
    const error = await apiError(new Response(body, { status }));
    assert.equal(error.status, status);
    assert.equal(error.title, "");
    assert.deepEqual(error.errors, {});
  }
});

test("APIError keeps a plain-text body as the detail", async () => {
  const plain = await apiError(
    new Response("401 invalid api key\n", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
  assert.equal(plain.detail, "401 invalid api key");

  const html = await apiError(
    new Response("<html><body>Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
  );
  assert.equal(html.detail, "");

  const problemDetail = await apiError(problem(404, { detail: "No snapshot found" }));
  assert.equal(problemDetail.detail, "No snapshot found");
});

test("APIError falls back to the problem instance for the request ID", async () => {
  const error = await apiError(problem(404, { instance: "instance-id" }));

  assert.equal(error.requestID, "instance-id");
});

test("APIError keeps a __proto__ field as data", async () => {
  const error = await apiError(
    new Response('{"errors": {"__proto__": ["polluted"], "ip": ["bad"]}}', { status: 422 }),
  );

  assert.deepEqual(Object.keys(error.errors), ["__proto__", "ip"]);
  assert.equal(Object.getPrototypeOf(error.errors), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("APIError can be constructed for tests", () => {
  assert.equal(new APIError({ status: 404 }).message, "404 Not Found");
  assert.equal(new APIError({ status: 599 }).message, "599");
  assert.deepEqual(new APIError({ status: 404 }).errors, {});
});

test("errors form a small hierarchy", () => {
  const timeout = new APITimeoutError("request timed out");

  assert.ok(timeout instanceof APIConnectionError);
  assert.ok(timeout instanceof SynthientError);
  assert.ok(new APIError({ status: 500 }) instanceof SynthientError);
  assert.deepEqual(
    [
      new SynthientError("x"),
      new APIConnectionError("x"),
      timeout,
      new APIError({ status: 500 }),
    ].map((error) => error.name),
    ["SynthientError", "APIConnectionError", "APITimeoutError", "APIError"],
  );
});

test("a failed error body read keeps the status", async (t) => {
  const server = await serve(t, (_, res) => {
    res.writeHead(500, { "content-type": "application/json", "content-length": "100" });
    res.write('{"title":');
    setTimeout(() => res.destroy(), 10);
  });

  await assert.rejects(
    newClient({ baseURL: server.baseURL, maxRetries: 0 }).account(),
    (error: unknown) => {
      return (
        error instanceof APIError &&
        error.status === 500 &&
        error.cause instanceof APIConnectionError
      );
    },
  );
});

test("successful bodies must be complete JSON objects within the limit", async () => {
  const bodies = [
    ["{not json", "invalid JSON in response"],
    ["[]", "response is not a JSON object"],
    ["null", "response is not a JSON object"],
    ['"text"', "response is not a JSON object"],
    [`{"x":"${"a".repeat(16 << 20)}"}`, `response body exceeds ${16 << 20} bytes`],
  ] as const;
  for (const [body, message] of bodies) {
    const { fetch } = stub(() => new Response(body, { status: 200 }));

    await assert.rejects(newClient({ fetch }).account(), { name: "SynthientError", message });
  }
});

test("server data stays out of error messages", async () => {
  const { fetch } = stub(() => {
    return json(403, { title: "secret-title", detail: "secret-detail\r\nInjected: 1" });
  });

  await assert.rejects(newClient({ fetch }).account(), (error: unknown) => {
    assert.ok(error instanceof APIError);
    assert.doesNotMatch(error.message, /secret/);
    assert.doesNotMatch(String(error), /secret/);
    assert.match(inspect(error), /secret-detail/);
    return true;
  });
});
