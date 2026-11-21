// Exercise shipped Team routes against synthetic data in a network-none container.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const requireApp = createRequire("/app/package.json");
const Database = requireApp("better-sqlite3");

async function main() {
  const db = new Database("/app/data/storage.sqlite");
  const suffix = randomUUID();
  const team = "team-" + suffix;
  const keys = ["key-a-" + suffix, "key-b-" + suffix];
  const token = "oma_live_" + randomBytes(32).toString("base64url");
  const now = Date.now();
  const created = new Date(now - 10 * 86400000).toISOString();
  const reset = new Date(now + 20 * 86400000).toISOString();
  const stamp = new Date(now - 86400000).toISOString();
  const day = stamp.slice(0, 10);
  db.prepare(
    "INSERT INTO cli_access_tokens (id,token_hash,token_prefix,name,scope,created_at) VALUES (?,?,?,?,?,?)"
  ).run(
    "tok-" + suffix,
    createHash("sha256").update(token).digest("hex"),
    token.slice(0, 12),
    "synthetic-team-reader",
    "read",
    created
  );
  db.prepare(
    "INSERT INTO teams (id,name,status,max_budget_usd,budget_duration,budget_reset_at,created_at,updated_at) VALUES (?,?,'active',100,'30d',?,?,?)"
  ).run(team, "Synthetic Team " + suffix, reset, created, created);
  for (const key of keys) {
    db.prepare("INSERT INTO api_keys (id,name,key,created_at) VALUES (?,?,?,?)").run(
      key,
      key,
      "synthetic-" + key,
      created
    );
    db.prepare(
      "INSERT INTO api_key_billing_team_history (id,api_key_id,team_id,valid_from,created_at) VALUES (?,?,?,?,?)"
    ).run(randomUUID(), key, team, created, created);
  }
  const id = db
    .prepare(
      "INSERT INTO usage_history (timestamp,provider,model,api_key_id,billing_team_id,tokens_input,tokens_output,success,endpoint,billing_unit,billing_quantity,provider_cost_usd) VALUES (?,?,?,?,?,3,49,1,'/v1/audio/transcriptions','second',22,0.0014)"
    )
    .run(
      stamp,
      "synthetic-audio-provider",
      "synthetic-transcription-model",
      keys[0],
      team
    ).lastInsertRowid;
  let checks = 0;
  async function status() {
    const response = await fetch("http://127.0.0.1:20128/api/teams/" + team, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.status, 200, "Shipped Team route must accept a scoped reader");
    const body = await response.json();
    assert.equal(body.members.length, 2);
    assert.equal(body.team.maxBudgetUsd, 100);
    assert.equal(body.team.budgetResetAt, reset);
    assert.equal(body.budgetStatus.unpricedUsagePolicy, "fail_closed");
    return body.budgetStatus;
  }
  function known(value, amount, actual = amount) {
    assert.equal(value.accountedCostUsd, amount);
    assert.equal(value.actualProviderCostUsd, actual);
    assert.equal(value.estimatedListCostUsd, 0);
    assert.equal(value.hasUnpricedUsage, false);
    assert.equal(value.hasUnpricedListUsage, true);
    assert.equal(value.exceeded, false);
    assert.equal(value.blockReason, null);
    checks++;
  }
  known(await status(), 0.0014);
  db.prepare("UPDATE usage_history SET provider_cost_usd=0 WHERE id=?").run(id);
  known(await status(), 0);
  db.prepare(
    "UPDATE usage_history SET provider_cost_usd=NULL,calculated_cost_usd=0.002 WHERE id=?"
  ).run(id);
  known(await status(), 0.002, null);
  db.prepare("UPDATE usage_history SET calculated_cost_usd=NULL WHERE id=?").run(id);
  const unknown = await status();
  assert.equal(unknown.exceeded, true);
  assert.equal(unknown.blockReason, "unpriced_usage");
  assert.equal(unknown.hasUnpricedUsage, true);
  assert.equal(unknown.accountedCostUsd, 0);
  assert.deepEqual(unknown.unpricedModels, [
    "synthetic-audio-provider/synthetic-transcription-model",
  ]);
  checks++;
  db.prepare("UPDATE usage_history SET provider_cost_usd=101 WHERE id=?").run(id);
  const exceeded = await status();
  assert.equal(exceeded.accountedCostUsd, 101);
  assert.equal(exceeded.actualProviderCostUsd, 101);
  assert.equal(exceeded.exceeded, true);
  assert.equal(exceeded.blockReason, "cap_exceeded");
  checks++;
  db.prepare(
    "UPDATE usage_history SET provider_cost_usd=0.0014,team_rollup_processed_at=? WHERE id=?"
  ).run(new Date().toISOString(), id);
  const shape = JSON.stringify([
    3,
    49,
    0,
    0,
    0,
    0.0014,
    null,
    "/v1/audio/transcriptions",
    "second",
  ]);
  const shapes = JSON.stringify({ [shape]: 1 });
  db.prepare(
    "INSERT INTO daily_team_usage_summary (team_id,api_key_id,provider,model,service_tier,date,total_requests,successful_requests,total_input_tokens,total_output_tokens,successful_input_tokens,successful_output_tokens,token_shapes_json,successful_token_shapes_json) VALUES (?,?,?,?,'standard',?,1,1,3,49,3,49,?,?)"
  ).run(
    team,
    keys[0],
    "synthetic-audio-provider",
    "synthetic-transcription-model",
    day,
    shapes,
    shapes
  );
  known(await status(), 0.0014);
  // The processed raw row must not be added to its retained representation.
  assert.equal((await status()).accountedCostUsd, 0.0014);
  checks++;
  db.close();
  console.log(
    "TEAM_BUDGET_IMAGE_SMOKE=" +
      JSON.stringify({
        checks,
        compiledHttpRoutes: true,
        data: "synthetic-tmpfs-only",
        network: "none",
        recordedSeconds: 22,
        defaultPolicy: "fail_closed",
        source: "published-image",
        verified: [
          "recorded-charge",
          "known-zero",
          "stored-estimate",
          "unknown-pricing-reason",
          "real-cap-overage",
          "retained-charge",
          "no-double-counting",
        ],
      })
  );
}
main().catch((error) => {
  console.error("Team budget image smoke failed: " + error.message);
  process.exitCode = 1;
});
