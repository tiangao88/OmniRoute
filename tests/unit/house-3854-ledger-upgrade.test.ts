import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "house-ledger-upgrade-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "synthetic-upgrade-key-secret";
const core = await import("../../src/lib/db/core.ts");
const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
const { tryOpenSync } = await import("../../src/lib/db/adapters/driverFactory.ts");
const teams = await import("../../src/lib/db/teams.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const usage = await import("../../src/lib/usage/usageHistory.ts");
const limits = await import("../../src/lib/usage/teamUsageLimits.ts");

test.after(() => {
  usage.clearPendingRequests();
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("old accounting ledger 228 reconciles once without changing a 200 USD Team", async () => {
  const now = Date.now();
  const team = teams.createTeam({
    name: "Synthetic upgrade Team",
    maxBudgetUsd: 200,
    budgetDuration: "30d",
  });
  const key = await keys.createApiKey("Synthetic upgrade reader", "synthetic-upgrade-machine");
  teams.assignApiKeyBillingTeam(key.id, team.id, new Date(now - 86400000).toISOString());
  const db = core.getDbInstance();
  const reset = new Date(now + 29 * 86400000).toISOString();
  db.prepare("UPDATE teams SET budget_reset_at=? WHERE id=?").run(reset, team.id);
  await usage.saveRequestUsage(
    {
      provider: "synthetic-audio",
      model: "synthetic-transcribe",
      apiKeyId: key.id,
      endpoint: "/v1/audio/transcriptions",
      success: true,
      tokens: { input: 3, output: 49, cost_usd: 0.0014 },
      billingUnit: "second",
      billingQuantity: 22,
      timestamp: new Date(now - 1000).toISOString(),
    },
    { deduplicate: false }
  );
  const before = db.prepare("SELECT * FROM teams WHERE id=?").get(team.id);
  const membership = db
    .prepare("SELECT * FROM api_key_billing_team_history WHERE team_id=?")
    .all(team.id);
  const request = db.prepare("SELECT * FROM usage_history WHERE api_key_id=?").all(key.id);
  db.prepare("DELETE FROM _omniroute_migrations WHERE version='237'").run();
  db.prepare(
    "UPDATE _omniroute_migrations SET name='usage_history_calculated_cost' WHERE version='228'"
  ).run();
  db.prepare(
    "INSERT INTO key_value(namespace,key,value) VALUES ('syncedAvailableModels','synthetic:missing-connection','[]')"
  ).run();
  const changed = runMigrations(db, { isNewDb: false, databaseExistedBeforeInitialization: true });
  assert.ok(changed > 0);
  assert.equal(
    db.prepare("SELECT name FROM _omniroute_migrations WHERE version='237'").get().name,
    "usage_history_calculated_cost"
  );
  assert.equal(
    db.prepare("SELECT name FROM _omniroute_migrations WHERE version='228'").get().name,
    "purge_orphaned_provider_catalogs"
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM key_value WHERE namespace='syncedAvailableModels' AND key='synthetic:missing-connection'"
      )
      .get().n,
    0
  );
  assert.deepEqual(db.prepare("SELECT * FROM teams WHERE id=?").get(team.id), before);
  assert.deepEqual(
    db.prepare("SELECT * FROM api_key_billing_team_history WHERE team_id=?").all(team.id),
    membership
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM usage_history WHERE api_key_id=?").all(key.id),
    request
  );
  const status = await limits.getTeamUsageLimitStatusForApiKey(key.id, now);
  assert.equal(status.maxBudgetUsd, 200);
  assert.equal(status.resetAtIso, reset);
  assert.equal(status.accountedCostUsd, 0.0014);
  assert.equal(status.exceeded, false);
  assert.equal(runMigrations(db, { isNewDb: false }), 0);
  const files = fs
    .readdirSync(path.join(dir, "db_backups"))
    .filter((name) => /^db_state-[a-f0-9]{64}_pre-migration\.sqlite$/.test(name));
  assert.equal(files.length, 1, "one durable pre-reconciliation restore point");
  const snapshot = tryOpenSync(path.join(dir, "db_backups", files[0]), {
    readonly: true,
    fileMustExist: true,
  });
  assert.ok(snapshot);
  try {
    assert.equal(
      snapshot.prepare("SELECT name FROM _omniroute_migrations WHERE version='228'").get().name,
      "usage_history_calculated_cost"
    );
    assert.equal(
      snapshot.prepare("SELECT 1 FROM _omniroute_migrations WHERE version='237'").get(),
      undefined
    );
    assert.deepEqual(snapshot.prepare("SELECT * FROM teams WHERE id=?").get(team.id), before);
    assert.deepEqual(
      snapshot.prepare("SELECT * FROM usage_history WHERE api_key_id=?").all(key.id),
      request
    );
  } finally {
    snapshot.close();
  }
});
