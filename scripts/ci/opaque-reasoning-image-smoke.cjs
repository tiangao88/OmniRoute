// Offline qualification of the actual shipped webpack modules, not source imports.
// Run only in a disposable container with no network and no production data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.APP_LOG_TO_FILE = "false";
process.env.PII_RESPONSE_SANITIZATION = "true";
process.env.PII_RESPONSE_SANITIZATION_MODE = "redact";
process.env.CREDENTIAL_REDACTION_ENABLED = "true";
// Unused provider-client version discovery must not reach external registries.
process.env.CLAUDE_CODE_CLIENT_VERSION = "1.0.0";
process.env.CODEX_CLIENT_VERSION = "1.0.0";
process.env.GITHUB_COPILOT_CLI_VERSION = "1.0.0";
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error("Network forbidden in compiled stream smoke");
};

async function main() {
  const server = ["/app/.build/next/server", "/app/.next/server"].find((dir) =>
    fs.existsSync(path.join(dir, "webpack-runtime.js"))
  );
  assert(server, "Shipped webpack runtime missing");
  const runtime = require(path.join(server, "webpack-runtime.js"));
  for (const name of fs.readdirSync(path.join(server, "chunks"))) {
    if (!name.endsWith(".js")) continue;
    const chunk = require(path.join(server, "chunks", name));
    if (chunk.modules) runtime.C(chunk);
  }
  async function exportedFactory(moduleMarker, functionMarker) {
    const matches = Object.entries(runtime.m).filter(([, factory]) =>
      factory.toString().includes(moduleMarker)
    );
    assert.equal(matches.length, 1, "Expected one compiled module: " + moduleMarker);
    const exports = await runtime(matches[0][0]);
    const functions = Object.values(exports).filter(
      (value) => typeof value === "function" && value.toString().includes(functionMarker)
    );
    assert.equal(functions.length, 1, "Expected one shipped transform export");
    return functions[0];
  }
  const credential = await exportedFactory(
    "Credential stream choice limit exceeded",
    "processToolArgs"
  );
  const pii = await exportedFactory("PII_TEST_BYPASS_MIN_WINDOW", "PII_WINDOW_SIZE");
  const secret = "sk-" + "A1b2".repeat(12);
  const opaque = [0, 1].map((index) => ({
    index,
    id: "synthetic-reason-" + index,
    type: "reasoning.encrypted",
    format: "azure-openai-responses-v1",
    data: "gAAAA" + String(index).repeat(1200 - index * 300),
    encrypted_content: "opaque-envelope-" + index,
    signature: "synthetic-signature-" + secret,
    extension: { nested: secret },
  }));
  const frame = (value) => "data: " + JSON.stringify(value) + "\n\n";
  const delta = (value) => ({ choices: [{ index: 3, delta: value }] });
  const tool = {
    index: 2,
    id: "call-synthetic",
    type: "function",
    function: { name: "submit", arguments: '{"ok":true}' },
  };
  let checks = 0;
  async function run(input, mode, fragment) {
    const bytes = new TextEncoder().encode(input);
    let offset = 0;
    let stream = new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + fragment));
        offset = Math.min(bytes.length, offset + fragment);
      },
    });
    if (mode !== "credential") stream = stream.pipeThrough(pii());
    if (mode !== "pii") stream = stream.pipeThrough(credential());
    const text = await new Response(stream).text();
    return text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:") && line.slice(5).trim().startsWith("{"))
      .map((line) => JSON.parse(line.slice(5)));
  }
  for (const mode of ["credential", "pii", "composed"]) {
    for (const fragment of [1, 37]) {
      for (const ending of ["finish", "done", "eof"]) {
        const input =
          opaque.map((value) => frame(delta({ reasoning_details: [value] }))).join("") +
          frame(delta({ content: "public answer", tool_calls: [tool] })) +
          (ending === "finish"
            ? frame({ choices: [{ index: 3, delta: {}, finish_reason: "tool_calls" }] })
            : "") +
          (ending === "eof" ? "" : "data: [DONE]\n\n");
        const events = await run(input, mode, fragment);
        const choices = events.flatMap((event) => event.choices ?? []);
        assert(
          choices.every((choice) => choice.index === 3),
          "Reasoning index changed choice identity"
        );
        const deltas = choices.map((choice) => choice.delta);
        assert.deepEqual(
          deltas.flatMap((value) => value.reasoning_details ?? []),
          opaque
        );
        assert.equal(deltas.map((value) => value.content ?? "").join(""), "public answer");
        assert.equal(deltas.map((value) => value.reasoning ?? "").join(""), "");
        assert.equal(deltas.map((value) => value.reasoning_content ?? "").join(""), "");
        const calls = deltas.flatMap((value) => value.tool_calls ?? []);
        assert(
          calls.every((call) => call.index === 2),
          "Reasoning index changed tool identity"
        );
        assert.equal(calls.map((call) => call.id ?? "").join(""), tool.id);
        assert.equal(calls.map((call) => call.function?.name ?? "").join(""), tool.function.name);
        assert.equal(
          calls.map((call) => call.function?.arguments ?? "").join(""),
          tool.function.arguments
        );
        checks++;
      }
      const generic = await run(
        frame({
          id: "synthetic-envelope",
          model: "synthetic-model",
          provider: "synthetic-provider",
          text: "public " + secret,
          reasoning: "reason-one",
          reasoning_content: "reason-two",
          reasoning_details: opaque,
        }),
        mode,
        fragment
      );
      assert.deepEqual(
        generic.flatMap((event) => event.reasoning_details ?? []),
        opaque
      );
      assert(
        generic.every(
          (event) =>
            event.id === "synthetic-envelope" &&
            event.model === "synthetic-model" &&
            event.provider === "synthetic-provider"
        ),
        "Generic metadata changed"
      );
      assert.equal(generic.map((event) => event.reasoning ?? "").join(""), "reason-one");
      assert.equal(generic.map((event) => event.reasoning_content ?? "").join(""), "reason-two");
      const visible = generic.map((event) => event.text ?? "").join("");
      assert(visible.startsWith("public "));
      if (mode !== "pii") assert(!visible.includes(secret), "Credential masking disabled");
      checks++;
    }
  }
  assert.equal(networkCalls, 0, "Compiled smoke attempted an external request");
  console.log(
    "OPAQUE_IMAGE_SMOKE=" +
      JSON.stringify({
        checks,
        result: "pass",
        compiledModules: true,
        modes: ["credential", "pii", "composed"],
        fragmentation: [1, 37],
        networkCalls,
      })
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
