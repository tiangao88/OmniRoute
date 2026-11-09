import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hourly-reporting-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "hourly-reporting-fixture-only";
const core = await import("../../src/lib/db/core.ts");
const route = await import("../../src/app/api/usage/analytics/route.ts");
const cache = await import("../../src/lib/usage/analyticsResponseCache.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test.beforeEach(() => {
  cache.clearAnalyticsResponseCache();
  core.getDbInstance().prepare("DELETE FROM usage_history").run();
  core.getDbInstance().prepare("DELETE FROM daily_usage_summary").run();
});
function insert(timestamp: string, cost: number) {
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO usage_history (timestamp,provider,model,tokens_input,tokens_output,success,provider_cost_usd) VALUES (?, 'test', 'hour-model', 10, 5, 1, ?)"
    )
    .run(timestamp, cost);
}
async function read(start: string, end: string, hourly = true, timeZone = "Europe/Paris") {
  const query = new URLSearchParams({ timeZone, startDate: start, endDate: end });
  if (hourly) query.set("granularity", "hour");
  return route.GET(new Request("http://localhost/api/usage/analytics?" + query));
}

test("hourly opt-in returns real UTC instants, keeps repeated Paris hours distinct and preserves stored costs", async () => {
  insert("2026-10-25T00:10:00.000Z", 1);
  insert("2026-10-25T00:50:00.000Z", 2);
  insert("2026-10-25T01:20:00.000Z", 4);
  insert("2026-10-25T23:30:00.000Z", 99); // Outside the selected 25-hour local day.
  const response = await read("2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reporting.granularity, "hour");
  assert.equal(body.reporting.timeZone, "Europe/Paris");
  assert.equal(body.summary.totalCost, 7);
  assert.equal(body.summary.totalRequests, 3);
  assert.deepEqual(
    body.hourlyTrend.map(
      (r: { start: string; requests: number; totalTokens: number; cost: number }) => [
        r.start,
        r.requests,
        r.totalTokens,
        r.cost,
      ]
    ),
    [
      ["2026-10-25T00:00:00.000Z", 2, 30, 3],
      ["2026-10-25T01:00:00.000Z", 1, 15, 4],
    ]
  );
  assert.deepEqual(body.dailyTrend, []);
  const daily = await (
    await read("2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", false)
  ).json();
  assert.equal(daily.reporting.granularity, "day");
  assert.deepEqual(
    daily.dailyTrend.map((r: { date: string; cost: number }) => [r.date, r.cost]),
    [["2026-10-25", 7]]
  );
  assert.equal(daily.hourlyTrend, undefined);
});

test("23-hour Paris spring day is bounded and missing hours are never fabricated or zero-filled", async () => {
  insert("2026-03-29T00:20:00.000Z", 1);
  insert("2026-03-29T01:20:00.000Z", 2);
  const body = await (await read("2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z")).json();
  assert.deepEqual(
    body.hourlyTrend.map((r: { start: string }) => r.start),
    ["2026-03-29T00:00:00.000Z", "2026-03-29T01:00:00.000Z"]
  );
  assert.equal(body.summary.totalCost, 3);
});
test("offset-qualified hourly bounds are normalized to UTC before SQLite filtering", async () => {
  insert("2026-10-24T22:30:00.000Z", 1);
  insert("2026-10-25T22:30:00.000Z", 2);
  const body = await (await read("2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00")).json();
  assert.equal(body.summary.totalCost, 3);
  assert.equal(body.hourlyTrend.length, 2);
});
test("fixed empty-window Builder probe proves hourly capability without reading a usage period", async () => {
  const response = await read("2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.reporting.granularity, "hour");
  assert.equal(body.reporting.timeZone, "Europe/Paris");
  assert.equal(body.summary.totalRequests, 0);
  assert.deepEqual(body.hourlyTrend, []);
});

test("hourly UTC reads exclude daily summaries rather than distributing their totals across invented hours", async () => {
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO daily_usage_summary (date,provider,model,total_requests,total_input_tokens,total_output_tokens,total_cost) VALUES ('2024-12-31','test','hour-model',7,70,35,7)"
    )
    .run();
  const hourly = await (
    await read("2024-12-31T00:00:00Z", "2024-12-31T23:59:59Z", true, "UTC")
  ).json();
  assert.equal(hourly.summary.totalRequests, 0);
  assert.deepEqual(hourly.hourlyTrend, []);
  assert.equal(hourly.reporting.summarizedHistoryExcluded, true);
  const daily = await (
    await read("2024-12-31T00:00:00Z", "2024-12-31T23:59:59Z", false, "UTC")
  ).json();
  assert.equal(daily.summary.totalRequests, 7);
});

test("hourly aggregation rejects invalid/duplicate granularities and unbounded or ambiguous windows", async () => {
  for (const query of [
    "granularity=minute",
    "granularity=hour&granularity=day",
    "granularity=hour&range=all",
    "granularity=hour&startDate=bad&endDate=bad",
    "granularity=hour&startDate=2026-02-30T00:00:00Z&endDate=2026-03-02T01:00:00Z",
    "granularity=hour&startDate=2026-10-25&endDate=2026-10-25",
    "granularity=hour&startDate=2026-10-24T00:00:00Z&endDate=2026-10-26T00:00:00Z",
    "granularity=hour&startDate=2026-10-26T00:00:00Z&endDate=2026-10-25T00:00:00Z",
    "granularity=hour&startDate=2026-10-25T00:00:00Z&endDate=2026-10-25T01:00:00Z&presets=30d",
  ]) {
    const response = await route.GET(new Request("http://localhost/api/usage/analytics?" + query));
    assert.equal(response.status, 400, query);
    assert.ok(!JSON.stringify(await response.json()).includes(directory));
  }
});
