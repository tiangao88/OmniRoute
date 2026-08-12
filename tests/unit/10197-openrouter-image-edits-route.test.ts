// #10197 (tiangao88): route-level coverage for the built-in OpenRouter branch
// that /v1/images/edits gained in this PR. Exercises the actual POST(request)
// handler so the credentials / rate-limit / forward-to-OpenRouter branches
// added to route.ts itself are proven, not just the downstream service call.
//
// Before this change: POST /v1/images/edits rejected the built-in `openrouter`
// provider ("Image edit is not supported for built-in provider"), so image
// Combos routing through OpenRouter could generate but never edit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openrouter-edits-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "openrouter-edits-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

interface ErrorResponseBody {
  error: { message: string; code?: string };
}

interface ImageResponseBody {
  data: Array<{ b64_json?: string; url?: string }>;
}

const originalFetch = globalThis.fetch;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

function seedOpenRouterConnection(overrides: { rateLimitedUntil?: string | null } = {}) {
  return providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "openrouter-test",
    apiKey: "sk-or-test-openrouter-edits",
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: overrides.rateLimitedUntil ?? null,
  });
}

function dataUrlPng(bytes: number[]): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

const REF_A = dataUrlPng([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("#10197 v1 image edit POST forwards built-in openrouter edits to openrouter.ai/images/edits", async () => {
  await seedOpenRouterConnection();

  let hitUrl: string | null = null;
  let hitAuth: string | null = null;
  let hitBody: Buffer | null = null;

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    hitUrl = String(url);
    hitAuth = String(init.headers instanceof Headers ? init.headers.get("authorization") : "");
    // capture the multipart body as raw bytes
    const raw = init.body;
    if (raw instanceof ArrayBuffer) hitBody = Buffer.from(raw);
    else if (raw && typeof (raw as { arrayBuffer?: unknown }).arrayBuffer === "function") {
      hitBody = Buffer.from(await (raw as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
    }
    return new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/google/gemini-3.1-flash-image-preview",
        prompt: "add a red hat",
        images: [REF_A],
      }),
    })
  );
  const body = (await response.json()) as ImageResponseBody;

  assert.equal(response.status, 200);
  assert.ok(body.data[0].b64_json, "edit must return an image payload");

  // Must hit OpenRouter's own edit endpoint (registry base URL rewritten).
  assert.equal(hitUrl, "https://openrouter.ai/api/v1/images/edits");
  // Must carry the OpenRouter connection key as a Bearer token.
  assert.equal(hitAuth, "Bearer sk-or-test-openrouter-edits");
  // Multipart body must include model (provider prefix stripped) and prompt.
  assert.ok(hitBody, "multipart body must be captured");
  const bodyStr = hitBody.toString("utf8");
  assert.ok(bodyStr.includes('name="model"'), "multipart must carry model field");
  assert.ok(bodyStr.includes("google/gemini-3.1-flash-image-preview"), "model must be prefix-stripped");
  assert.ok(bodyStr.includes('name="prompt"'), "multipart must carry prompt field");
  assert.ok(bodyStr.includes("add a red hat"), "prompt must be forwarded");
  assert.ok(bodyStr.includes('name="image"'), "multipart must carry the image file");
});

test("#10197 v1 image edit POST surfaces missing openrouter credentials", async () => {
  // No openrouter connection seeded at all.
  globalThis.fetch = async () => {
    throw new Error("Missing-credentials path must not reach upstream");
  };

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/openai/gpt-5-image-mini",
        prompt: "edit this",
        images: [REF_A],
      }),
    })
  );
  const body = (await response.json()) as ErrorResponseBody;

  assert.equal(response.status, 401);
  assert.match(body.error.message, /No credentials for provider: openrouter/);
  // Hard Rule #12 — error responses must never leak a raw stack trace.
  assert.ok(!body.error.message.includes("at /"));
});

test("#10197 v1 image edit POST surfaces openrouter rate-limit sentinel", async () => {
  await seedOpenRouterConnection({ rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() });
  globalThis.fetch = async () => {
    throw new Error("Rate-limited path must not reach upstream");
  };

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/openai/gpt-5.4-image-2",
        prompt: "edit this",
        images: [REF_A],
      }),
    })
  );
  const body = (await response.json()) as ErrorResponseBody;

  assert.equal(response.status, 429);
  assert.match(body.error.message, /All accounts rate limited/);
  assert.ok(!body.error.message.includes("at /"));
});
