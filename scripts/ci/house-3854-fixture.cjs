// Synthetic upgrade state only. Never run against a production DATA_DIR.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { randomBytes, createHash, createCipheriv, scryptSync } = require("node:crypto");
const Database = createRequire("/app/package.json")("better-sqlite3");
const db = new Database("/app/data/storage.sqlite");
const created = new Date(Date.now() - 10 * 86400000).toISOString();
const reset = new Date(Date.now() + 20 * 86400000).toISOString();
const stamp = new Date(Date.now() - 86400000).toISOString();
const team = "synthetic-upgrade-team";
const token = "oma_live_" + randomBytes(32).toString("base64url");
const storageSecret = "synthetic-house-storage-key-qualification-only";
const plain = "synthetic-provider-credential-not-valid";
const iv = randomBytes(16);
const cipher = createCipheriv("aes-256-gcm", scryptSync(storageSecret, "omniroute-field-encryption-v1", 32), iv);
const encrypted = cipher.update(plain, "utf8", "hex") + cipher.final("hex");
const envelope = "enc:v1:" + iv.toString("hex") + ":" + encrypted + ":" + cipher.getAuthTag().toString("hex");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const queries = {
  team: "SELECT id,name,status,max_budget_usd,budget_duration,budget_reset_at FROM teams WHERE id='synthetic-upgrade-team'",
  keys: "SELECT id,name,key,allowed_models FROM api_keys WHERE id LIKE 'synthetic-upgrade-key-%' ORDER BY id",
  members: "SELECT api_key_id,team_id,valid_from FROM api_key_billing_team_history WHERE team_id='synthetic-upgrade-team' ORDER BY api_key_id",
  providers: "SELECT id,provider,name,api_key FROM provider_connections WHERE id='synthetic-upgrade-connection'",
  nodes: "SELECT id,type,name,prefix,base_url FROM provider_nodes WHERE id='synthetic-upgrade-node'",
  combos: "SELECT id,name,data FROM combos WHERE id='synthetic-upgrade-combo'",
  pricing: "SELECT namespace,key,value FROM key_value WHERE namespace='pricing' AND key='synthetic-token-provider'",
  catalog: "SELECT namespace,key,value FROM key_value WHERE namespace='syncedAvailableModels' AND key='synthetic-upgrade-node:synthetic-upgrade-connection'",
  usage: "SELECT timestamp,provider,model,api_key_id,billing_team_id,tokens_input,tokens_output,success,provider_cost_usd,calculated_cost_usd,billing_unit,billing_quantity,team_rollup_processed_at FROM usage_history WHERE billing_team_id='synthetic-upgrade-team' ORDER BY id",
  retained: "SELECT * FROM daily_team_usage_summary WHERE team_id='synthetic-upgrade-team' ORDER BY date",
};
async function main() {
  assert.equal(db.prepare("SELECT name FROM _omniroute_migrations WHERE version='228'").get().name, "usage_history_calculated_cost");
  db.prepare("INSERT INTO cli_access_tokens(id,token_hash,token_prefix,name,scope,created_at) VALUES (?,?,?,?,?,?)")
    .run("synthetic-upgrade-reader", createHash("sha256").update(token).digest("hex"), token.slice(0,12), "Synthetic reader", "read", created);
  db.prepare("INSERT INTO teams(id,name,status,max_budget_usd,budget_duration,budget_reset_at,created_at,updated_at) VALUES (?,?,'active',200,'30d',?,?,?)")
    .run(team, "Synthetic upgrade Team", reset, created, created);
  for (let i=0;i<10;i++) {
    const key="synthetic-upgrade-key-"+i;
    db.prepare("INSERT INTO api_keys(id,name,key,allowed_models,created_at) VALUES (?,?,?,?,?)")
      .run(key,"Synthetic key "+i,"synthetic-inference-"+i,JSON.stringify(["synthetic-route"]),created);
    db.prepare("INSERT INTO api_key_billing_team_history(id,api_key_id,team_id,valid_from,created_at) VALUES (?,?,?,?,?)")
      .run("synthetic-membership-"+i,key,team,created,created);
  }
  db.prepare("INSERT INTO provider_nodes(id,type,name,prefix,base_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("synthetic-upgrade-node","openai-compatible","Synthetic EU node","synthetic-eu","https://eu.openrouter.ai/api/v1",created,created);
  db.prepare("INSERT INTO provider_connections(id,provider,auth_type,name,api_key,is_active,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)")
    .run("synthetic-upgrade-connection","synthetic-upgrade-node","apikey","Synthetic connection",envelope,created,created);
  db.prepare("INSERT INTO combos(id,name,data,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run("synthetic-upgrade-combo","synthetic-route",JSON.stringify({models:["synthetic-eu/synthetic-model"],strategy:"priority"}),created,created);
  db.prepare("INSERT INTO key_value(namespace,key,value) VALUES ('pricing','synthetic-token-provider',?)")
    .run(JSON.stringify({"synthetic-model":{input:1,output:2,_source:"user"}}));
  db.prepare("INSERT INTO key_value(namespace,key,value) VALUES ('syncedAvailableModels','synthetic-upgrade-node:synthetic-upgrade-connection',?)")
    .run(JSON.stringify([{id:"synthetic-model",name:"Synthetic model"}]));
  db.prepare("INSERT INTO usage_history(timestamp,provider,model,api_key_id,billing_team_id,tokens_input,tokens_output,success,endpoint,billing_unit,billing_quantity,provider_cost_usd) VALUES (?,?,?,?,?,3,49,1,'/v1/audio/transcriptions','second',22,0.0014)")
    .run(stamp,"synthetic-audio","synthetic-transcribe","synthetic-upgrade-key-0",team);
  const shape=JSON.stringify({[JSON.stringify([0,0,0,0,0,null,0.002,"/v1/ocr","page"])]:1});
  db.prepare("INSERT INTO daily_team_usage_summary(team_id,api_key_id,provider,model,service_tier,date,total_requests,successful_requests,token_shapes_json,successful_token_shapes_json) VALUES (?,?,?,?,'standard',?,1,1,?,?)")
    .run(team,"synthetic-upgrade-key-1","synthetic-ocr","synthetic-ocr-model",stamp.slice(0,10),shape,shape);
  const fingerprints=Object.fromEntries(Object.entries(queries).map(([key,sql])=>[key,hash(db.prepare(sql).all())]));
  const meta={team,token,reset,queries,fingerprints,expectedAccountedCostUsd:0.0034};
  fs.writeFileSync("/tmp/house-fixture-meta.json",JSON.stringify(meta));
  await db.backup("/tmp/house-fixture.sqlite");
  db.close();
  console.log(JSON.stringify({seeded:true,synthetic:true,members:10,capUsd:200,ledger:"228_usage_history_calculated_cost"}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
