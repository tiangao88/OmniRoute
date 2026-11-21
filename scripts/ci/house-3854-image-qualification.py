"""Exact-image checks with fresh tmpfs data, real old-image state and native snapshot restore."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

BASELINE = "ghcr.io/tiangao88/omniroute:3.8.53-house-cumulative-team-budget-0a020e485@sha256:958e03fc886dc3d15bfe15f9e4ad3b9fce4aef17c4946a74342b42c9fb80536a"
digest = os.environ["IMAGE_DIGEST"]
source = os.environ["SOURCE_COMMIT"]
assert re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
assert re.fullmatch(r"[a-f0-9]{40}", source)
image = "ghcr.io/tiangao88/omniroute@" + digest
report = {"image": image, "source": source, "baselineImage": BASELINE,
          "network": "none", "data": "synthetic tmpfs only", "paidModelCalls": 0,
          "productionMutation": False, "checks": []}
owned = []


def run(args, *, text=True, input=None, allow_failure=False, timeout=180):
    result = subprocess.run(args, input=input, text=text, capture_output=True, timeout=timeout)
    if result.returncode and not allow_failure:
        raise RuntimeError("Command failed: " + " ".join(args[:5]) + "; " + str(result.stderr)[-2200:])
    return result


def record(name, details):
    report["checks"].append({"name": name, "result": "pass", "details": details})
    Path("house-image-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report["checks"][-1]), flush=True)


def node(container, code):
    return run(["docker", "exec", "-i", container, "node"], input=code).stdout


def boot(name, ref, fixture=None, meta=None):
    inspected = json.loads(run(["docker", "image", "inspect", ref]).stdout)[0]
    assert not inspected["Config"].get("Volumes"), "Implicit named-volume creation is forbidden"
    assert inspected["Config"]["User"] == "node"
    args = ["docker", "create", "--name", name, "--network", "none",
            "--memory", "1536m", "--cpus", "2", "--pids-limit", "512",
            "--tmpfs", "/app/data:rw,nosuid,nodev,size=192m,uid=1000,gid=1000",
            "-e", "NEXT_TELEMETRY_DISABLED=1",
            "-e", "STORAGE_ENCRYPTION_KEY=synthetic-house-storage-key-qualification-only"]
    if fixture:
        assert inspected["Config"]["Entrypoint"] == ["/app/check-permissions.sh"]
        assert inspected["Config"]["Cmd"] == ["node", "dev/run-standalone.mjs"]
        args += ["--entrypoint", "/bin/sh", ref, "-c",
                 "cp /tmp/house-fixture.sqlite /app/data/storage.sqlite; exec /app/check-permissions.sh node dev/run-standalone.mjs"]
    else:
        args += [ref]
    run(args)
    owned.append(name)
    if fixture:
        os.chmod(fixture, 0o644)
        run(["docker", "cp", str(fixture), name + ":/tmp/house-fixture.sqlite"])
    if meta:
        os.chmod(meta, 0o644)
        run(["docker", "cp", str(meta), name + ":/tmp/house-fixture-meta.json"])
    run(["docker", "start", name])
    health = "const r=await fetch('http://127.0.0.1:20128/healthz',{signal:AbortSignal.timeout(4000)});if(r.status!==200||(await r.text()).trim()!=='ok')process.exit(1);"
    for _ in range(75):
        result = run(["docker", "exec", name, "node", "-e", health], allow_failure=True, timeout=15)
        if result.returncode == 0:
            return
        state = json.loads(run(["docker", "inspect", name]).stdout)[0]["State"]
        if not state["Running"]:
            raise RuntimeError(name + " exited: " + run(["docker", "logs", name], allow_failure=True).stdout[-2200:])
        time.sleep(2)
    raise RuntimeError("Readiness timeout: " + name)


VERIFY_STATE = r"""
const assert=require('node:assert/strict'),fs=require('node:fs');
const {createHash}=require('node:crypto'),{createRequire}=require('node:module');
const Database=createRequire('/app/package.json')('better-sqlite3');
const db=new Database('/app/data/storage.sqlite');
const meta=JSON.parse(fs.readFileSync('/tmp/house-fixture-meta.json','utf8'));
for(const [key,sql] of Object.entries(meta.queries)){
 const actual=createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');
 assert.equal(actual,meta.fingerprints[key],'Synthetic state changed: '+key);
}
async function main(){
 const r=await fetch('http://127.0.0.1:20128/api/teams/'+meta.team,{headers:{Authorization:'Bearer '+meta.token},signal:AbortSignal.timeout(10000)});
 assert.equal(r.status,200);
 const b=await r.json();
 assert.equal(b.team.maxBudgetUsd,200);assert.equal(b.team.budgetResetAt,meta.reset);
 assert.equal(b.members.length,10);assert.equal(b.budgetStatus.accountedCostUsd,meta.expectedAccountedCostUsd);
 assert.equal(b.budgetStatus.exceeded,false);assert.equal(b.budgetStatus.unpricedUsagePolicy,'fail_closed');
 db.close();
 console.log(JSON.stringify({fingerprints:Object.keys(meta.fingerprints).length,members:10,capUsd:200,window:'30d',accountedCostUsd:b.budgetStatus.accountedCostUsd,exceeded:false,readScope:true}));
} main().catch(e=>{console.error(e.message);process.exitCode=1;});
"""

try:
    run(["docker", "pull", image], timeout=600)
    config = json.loads(run(["docker", "image", "inspect", image]).stdout)[0]
    assert config["Config"]["Labels"]["org.opencontainers.image.revision"] == source
    assert config["Architecture"] == "amd64" and config["Os"] == "linux"
    record("immutable image provenance", {"revision": source, "architecture": "linux/amd64",
                                         "repoDigests": config["RepoDigests"]})
    fresh = "house-3854-fresh"
    boot(fresh, image)
    run(["docker", "exec", fresh, "node", "healthcheck.mjs"])
    negative = run(["docker", "exec", "-e", "OMNIROUTE_HEALTHCHECK_PATH=/__missing_qualification__",
                    fresh, "node", "healthcheck.mjs"], allow_failure=True)
    assert negative.returncode != 0
    record("fresh boot and positive/negative shipped healthcheck", True)
    runtime = node(fresh, r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),{createRequire}=require('node:module');
const req=createRequire('/app/package.json'),Database=req('better-sqlite3'),db=new Database('/app/data/storage.sqlite');
assert.equal(req('/app/package.json').version,'3.8.54');
assert.equal(req('/usr/local/lib/node_modules/@openai/codex/package.json').version,'0.165.0');
assert.equal(db.prepare("SELECT name FROM _omniroute_migrations WHERE version='237'").get().name,'usage_history_calculated_cost');
console.log(JSON.stringify({version:'3.8.54',node:process.version,sqlite:db.prepare('select sqlite_version() version').get().version,codex:'0.165.0',billingMigration:237}));db.close();
""")
    record("version, native SQLite, CLI pin and canonical billing migration", json.loads(runtime))
    for filename, prefix in [("opaque-reasoning-image-smoke.cjs", "OPAQUE_IMAGE_SMOKE="),
                             ("team-budget-image-smoke.cjs", "TEAM_BUDGET_IMAGE_SMOKE=")]:
        output = node(fresh, Path("scripts/ci", filename).read_text())
        values = [json.loads(line.split("=", 1)[1]) for line in output.splitlines() if line.startswith(prefix)]
        assert len(values) == 1 and values[0]["checks"] > 0
        if prefix.startswith("OPAQUE"):
            assert values[0]["networkCalls"] == 0
        record(filename, values[0])
    auth = node(fresh, r"""
async function main(){const r=await fetch('http://127.0.0.1:20128/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-invalid-key'},body:JSON.stringify({model:'__synthetic_missing__',messages:[{role:'user',content:'synthetic'}]})});if(![401,403].includes(r.status))throw Error('Invalid-key guard failed');console.log(JSON.stringify({status:r.status}));}main().catch(e=>{console.error(e.message);process.exitCode=1;});
""")
    record("invalid inference credential rejected without upstream traffic", json.loads(auth))
    paris = node(fresh, r"""
const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{randomBytes,createHash}=require('node:crypto');
const Database=createRequire('/app/package.json')('better-sqlite3'),db=new Database('/app/data/storage.sqlite');
const token='oma_live_'+randomBytes(32).toString('base64url');
db.prepare("INSERT INTO cli_access_tokens(id,token_hash,token_prefix,name,scope,created_at) VALUES (?,?,?,?,?,?)").run('synthetic-paris-reader',createHash('sha256').update(token).digest('hex'),token.slice(0,12),'Synthetic Paris reader','read',new Date().toISOString());
const insert=db.prepare("INSERT INTO usage_history(timestamp,provider,model,tokens_input,tokens_output,success,calculated_cost_usd) VALUES (?,'synthetic-paris','synthetic-model',10,5,1,1)");
for(const stamp of ['2026-01-31T23:30:00Z','2026-07-31T22:30:00Z','2026-03-29T22:30:00Z','2026-10-25T22:30:00Z'])insert.run(stamp);
db.close();
async function main(){for(const [start,end,day]of[['2026-01-31','2026-02-02','2026-02-01'],['2026-07-31','2026-08-02','2026-08-01'],['2026-03-29','2026-03-31','2026-03-30'],['2026-10-25','2026-10-27','2026-10-25']]){
 const q=new URLSearchParams({startDate:start+'T00:00:00Z',endDate:end+'T00:00:00Z',timeZone:'Europe/Paris',includeFlatRateEstimates:'false'});
 const r=await fetch('http://127.0.0.1:20128/api/usage/analytics?'+q,{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);
 const b=await r.json();assert.equal(b.reporting.version,1);assert.equal(b.reporting.timeZone,'Europe/Paris');
 assert.equal(b.dailyTrend.length,1);assert.equal(b.dailyTrend[0].date,day);assert.equal(b.dailyTrend[0].cost,1);
}console.log(JSON.stringify({calendarCases:4,winterSummerAndBothDstTransitions:true}));}main().catch(e=>{console.error(e.message);process.exitCode=1;});
""")
    record("native Paris reporting HTTP contract", json.loads(paris))
    run(["docker", "pull", BASELINE], timeout=600)
    old = "house-3853-fixture"
    boot(old, BASELINE)
    seed = node(old, Path("scripts/ci/house-3854-fixture.cjs").read_text())
    record("real cumulative 3.8.53 fixture", json.loads(seed))
    record("old image state and budget", json.loads(node(old, VERIFY_STATE)))
    with tempfile.TemporaryDirectory(prefix="house-image-upgrade-") as temporary:
        folder = Path(temporary)
        fixture, meta = folder / "fixture.sqlite", folder / "meta.json"
        run(["docker", "cp", old + ":/tmp/house-fixture.sqlite", str(fixture)])
        run(["docker", "cp", old + ":/tmp/house-fixture-meta.json", str(meta)])
        upgraded = "house-3854-upgraded"
        boot(upgraded, image, fixture, meta)
        record("old-image upgrade preserves state and clears no legitimate cap", json.loads(node(upgraded, VERIFY_STATE)))
        migration = node(upgraded, r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const Database=createRequire('/app/package.json')('better-sqlite3'),db=new Database('/app/data/storage.sqlite',{readonly:true});
assert.equal(db.prepare("SELECT name FROM _omniroute_migrations WHERE version='228'").get().name,'purge_orphaned_provider_catalogs');
assert.equal(db.prepare("SELECT name FROM _omniroute_migrations WHERE version='237'").get().name,'usage_history_calculated_cost');
db.close();let snapshot;
for(const name of fs.readdirSync('/app/data/db_backups')){
 if(!/^db_state-[a-f0-9]{64}_pre-migration\.sqlite$/.test(name))continue;
 const file=path.join('/app/data/db_backups',name),candidate=new Database(file,{readonly:true});
 const row=candidate.prepare("SELECT name FROM _omniroute_migrations WHERE version='228'").get();
 if(row?.name==='usage_history_calculated_cost')snapshot=file;
 candidate.close();
}assert(snapshot,'No native pre-reconciliation snapshot found');
console.log(JSON.stringify({canonical228:true,accounting237:true,snapshot}));
""")
        migration = json.loads(migration)
        snapshot = migration.pop("snapshot")
        assert re.fullmatch(r"/app/data/db_backups/db_state-[a-f0-9]{64}_pre-migration\.sqlite", snapshot)
        restored_file = folder / "native-restore.sqlite"
        run(["docker", "cp", upgraded + ":" + snapshot, str(restored_file)])
        record("native ledger reconciliation and durable snapshot", migration)
        restored = "house-3853-restored"
        boot(restored, BASELINE, restored_file, meta)
        record("old image boots with native recovery snapshot and original state", json.loads(node(restored, VERIFY_STATE)))
        run(["docker", "restart", upgraded])
        boot_probe = "const r=await fetch('http://127.0.0.1:20128/healthz');if(r.status!==200)process.exit(1)"
        for _ in range(60):
            result = run(["docker", "exec", upgraded, "node", "-e", boot_probe], allow_failure=True, timeout=15)
            if result.returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError("Upgraded test image did not restart")
        record("upgraded restart remains idempotent", json.loads(node(upgraded, VERIFY_STATE)))
    state = json.loads(run(["docker", "inspect", fresh]).stdout)[0]
    for _ in range(15):
        if state["State"].get("Health", {}).get("Status") == "healthy":
            break
        time.sleep(3)
        state = json.loads(run(["docker", "inspect", fresh]).stdout)[0]
    assert state["State"]["Running"] and state["State"]["Health"]["Status"] == "healthy"
    assert not state["State"]["OOMKilled"]
    record("Docker runtime health and resource boundaries", {
        "healthy": True, "oomKilled": False, "memory": state["HostConfig"]["Memory"],
        "nanoCpus": state["HostConfig"]["NanoCpus"], "pidsLimit": state["HostConfig"]["PidsLimit"],
        "network": state["HostConfig"]["NetworkMode"], "namedVolumes": len([m for m in state["Mounts"] if m["Type"] == "volume"])})
    assert state["HostConfig"]["NetworkMode"] == "none"
    assert not any(m["Type"] == "volume" for m in state["Mounts"])
    report["result"] = "pass"
except Exception as error:
    report["result"] = "fail"
    report["error"] = str(error)
    raise
finally:
    Path("house-image-report.json").write_text(json.dumps(report, indent=2))
    for container in reversed(owned):
        run(["docker", "rm", "-f", container], allow_failure=True)
