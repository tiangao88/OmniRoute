import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reporting-zone-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "reporting-test-only";
const core = await import("../../src/lib/db/core.ts");
const dbQueries = await import("../../src/lib/db/usageAnalytics.ts");
const calendar = await import("../../src/lib/db/usageAnalytics/reportingTime.ts");
const route = await import("../../src/app/api/usage/analytics/route.ts");
const cache = await import("../../src/lib/usage/analyticsResponseCache.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test.beforeEach(() => {
  cache.clearAnalyticsResponseCache();
  const db = core.getDbInstance();
  db.prepare("DELETE FROM usage_history").run();
  db.prepare("DELETE FROM daily_usage_summary").run();
});

function insert(timestamp: string, cost = 1) {
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO usage_history (timestamp,provider,model,tokens_input,tokens_output,success,calculated_cost_usd) VALUES (?, 'test', 'report-model', 10, 5, 1, ?)"
    )
    .run(timestamp, cost);
}

test("Paris day SQL follows IANA midnight and both daylight-saving transitions", () => {
  const db = core.getDbInstance();
  for (const [stamp, expected] of [
    ["2026-01-31T23:30:00.000Z", "2026-02-01"],
    ["2026-07-31T22:30:00.000Z", "2026-08-01"],
    ["2026-03-28T23:30:00.000Z", "2026-03-29"],
    ["2026-03-29T22:30:00.000Z", "2026-03-30"],
    ["2026-10-24T22:30:00.000Z", "2026-10-25"],
    ["2026-10-25T22:30:00.000Z", "2026-10-25"],
    ["2026-10-25T23:30:00.000Z", "2026-10-26"],
  ]) {
    const sql = calendar.reportingDaySql({
      timeZone: "Europe/Paris",
      sinceIso: "2026-01-01T00:00:00Z",
      untilIso: "2026-12-31T23:59:59Z",
    });
    const row = db
      .prepare<{ day: string }>(`SELECT ${sql} AS day FROM (SELECT ? AS timestamp)`)
      .get(stamp);
    assert.equal(row?.day, expected);
  }
  assert.throws(() =>
    calendar.reportingDaySql({
      timeZone: "invalid'); DROP TABLE usage_history;--",
      sinceIso: null,
      untilIso: null,
    })
  );
});

test("Paris analytics groups tokens and actual stored cost on the same local day", async () => {
  insert("2026-07-31T21:30:00.000Z", 1);
  insert("2026-07-31T22:30:00.000Z", 2);
  const response = await route.GET(
    new Request(
      "http://localhost/api/usage/analytics?timeZone=Europe%2FParis&startDate=2026-07-31T00:00:00Z&endDate=2026-08-02T00:00:00Z"
    )
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.dailyTrend.map((r: { date: string; requests: number; cost: number }) => [
      r.date,
      r.requests,
      r.cost,
    ]),
    [
      ["2026-07-31", 1, 1],
      ["2026-08-01", 1, 2],
    ]
  );
  assert.equal(body.summary.totalCost, 3);
  assert.equal(body.reporting.timeZone, "Europe/Paris");
  assert.equal(body.reporting.version, 1);
  assert.deepEqual(body.dailyByModel, [
    { date: "2026-07-31", "report-model": 15 },
    { date: "2026-08-01", "report-model": 15 },
  ]);
  assert.equal(body.activityMap["2026-07-31"], 15);
  assert.equal(body.activityMap["2026-08-01"], 15);
  assert.equal(body.weeklyCounts[5], 1);
  assert.equal(body.weeklyCounts[6], 1);
  // The response cache must never serve a Paris result to a default UTC client.
  const utc = await route.GET(
    new Request(
      "http://localhost/api/usage/analytics?startDate=2026-07-31T00:00:00Z&endDate=2026-08-02T00:00:00Z"
    )
  );
  const utcBody = await utc.json();
  assert.equal(utcBody.reporting.timeZone, "UTC");
  assert.equal(utcBody.dailyTrend.length, 1);
  assert.equal(utcBody.dailyTrend[0].cost, 3);
});

test("historical Paris heatmap excludes timestamps after the selected end", async () => {
  insert("2026-07-31T22:30:00.000Z");
  insert("2026-08-03T12:00:00.000Z");
  const response = await route.GET(
    new Request(
      "http://localhost/api/usage/analytics?timeZone=Europe%2FParis&startDate=2026-07-31T00:00:00Z&endDate=2026-08-02T00:00:00Z"
    )
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.activityMap, { "2026-08-01": 15 });
});

test("UTC rollups remain available in default reports but are honestly excluded from Paris", async () => {
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO daily_usage_summary (date,provider,model,total_requests,total_input_tokens,total_output_tokens,total_cost) VALUES ('2024-12-31','test','report-model',7,70,35,7)"
    )
    .run();
  const utc = await route.GET(
    new Request(
      "http://localhost/api/usage/analytics?startDate=2024-12-31T00:00:00Z&endDate=2025-01-02T00:00:00Z"
    )
  );
  const utcBody = await utc.json();
  assert.equal(
    utcBody.summary.totalRequests,
    7,
    JSON.stringify({
      reporting: utcBody.reporting,
      rows: core
        .getDbInstance()
        .prepare("SELECT date,total_requests FROM daily_usage_summary")
        .all(),
    })
  );
  const paris = await route.GET(
    new Request(
      "http://localhost/api/usage/analytics?timeZone=Europe%2FParis&startDate=2024-12-31T00:00:00Z&endDate=2025-01-02T00:00:00Z"
    )
  );
  const body = await paris.json();
  assert.equal(body.summary.totalRequests, 0);
  assert.equal(body.reporting.summarizedHistoryExcluded, true);
  const source = dbQueries.buildUnifiedSource({
    sinceIso: "2025-12-31T00:00:00Z",
    untilIso: null,
    rawCutoffDate: "2026-01-01",
    apiKeyWhere: "",
    apiKeyParams: {},
    rawOnly: true,
  });
  assert.ok(!source.unifiedSource.includes("FROM daily_usage_summary"));
});

test("time-zone inputs and unbounded Paris windows fail without stack or path disclosure", async () => {
  for (const query of [
    "timeZone=invalid",
    "timeZone=Europe%2FParis&timeZone=UTC",
    "timeZone=Europe%2FParis&range=all",
    "timeZone=Europe%2FParis&startDate=bad",
    "timeZone=Europe%2FParis&startDate=2024-01-01T00:00:00Z&endDate=2026-01-01T00:00:00Z",
    "timeZone=Europe%2FParis&startDate=2026-08-03T00:00:00Z&endDate=2026-08-02T00:00:00Z",
  ]) {
    const response = await route.GET(new Request("http://localhost/api/usage/analytics?" + query));
    assert.equal(response.status, 400);
    const body = JSON.stringify(await response.json());
    assert.ok(!body.includes("at /"));
    assert.ok(!body.includes(directory));
  }
});
