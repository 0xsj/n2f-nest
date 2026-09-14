#!/usr/bin/env python3
"""Selected identity PostgreSQL store mutations in isolated copies against an owned disposable database, with raw evidence."""
import hashlib,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
EVIDENCE=pathlib.Path(tempfile.mkdtemp(prefix="n2f-auth-store-mutations-"))
WORK=EVIDENCE/"work"
shutil.copytree(ROOT,WORK,ignore=shutil.ignore_patterns(".git","node_modules","target","dist","notes",".env","coverage"))
if LANG=="nest":(WORK/"node_modules").symlink_to(ROOT/"node_modules",target_is_directory=True)
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"PATH":NODE24+os.pathsep+os.environ.get("PATH",""),"GOCACHE":"/private/tmp/n2f-http-go-cache","CARGO_TARGET_DIR":"/private/tmp/n2f-identity-mutations-rs","CARGO_TERM_COLOR":"never","NO_COLOR":"1"}
DIRS={"go":"internal/identity","rs":"src/domains/identity","nest":"src/modules/identity"}
PROJECT="n2f-check-"+LANG
PORT={"go":17921,"rs":17922,"nest":17923}[LANG]
COMMANDS={"go":["go","test","-race","-count=1","./internal/identity/infra/postgres"],
"rs":["cargo","test","--offline","--locked","--test","identity_store_integration","--","--ignored"],
"nest":["pnpm","exec","vitest","run","src/modules/identity/infra/postgres/integration.spec.ts"]}
# (name, file under the identity directory, old, new); old must occur exactly once.
MUTATIONS={
"go":[
 ("duplicate_as_failure","infra/postgres/store.go",'pgErr.ConstraintName == "n2f_identity_credentials_email_unique"','false'),
 ("stale_login_ignored","infra/postgres/store.go","if !found || l.principal.Status != d.Active || l.credential.VerifiedAtMS == nil || l.credential.PasswordVersion != r.ExpectedPasswordVersion || l.epoch != r.ExpectedAuthEpoch {","if !found || l.epoch < 0 {"),
 ("consume_unguarded","infra/postgres/store.go"," AND consumed_at_ms IS NULL AND invalidated_at_ms IS NULL AND issued_at_ms<=$4"," AND invalidated_at_ms IS NULL AND issued_at_ms<=$4"),
 ("backward_time_admitted","infra/postgres/store.go","\t\t\tif r.NowMS < snap.LastSeenAtMS {\n\t\t\t\treturn rollback\n\t\t\t}\n",""),
 ("revoke_all_unguarded","infra/postgres/store.go","if !found || epoch != expectedEpoch {\n\t\t\treturn rollback\n\t\t}\n\t\tstate, e := d.NewAuthState(principal, epoch)\n\t\tif e != nil {\n\t\t\treturn corrupt(e)\n\t\t}\n\t\tnext, e := state.Invalidate(expectedEpoch)","if !found {\n\t\t\treturn rollback\n\t\t}\n\t\tstate, e := d.NewAuthState(principal, epoch)\n\t\tif e != nil {\n\t\t\treturn corrupt(e)\n\t\t}\n\t\tnext, e := state.Invalidate(epoch)"),
 ("events_dropped","infra/postgres/store.go","\t\tif e := ep.Enqueue(ctx, tx, ev); e != nil {\n\t\t\treturn e\n\t\t}","\t\t_ = ev\n\t\t_ = ep.Enqueue")],
"rs":[
 ("duplicate_as_failure","infra/postgres/mod.rs","=> return Err(marker(DUPLICATE)),","=> return Err(map(sqlx::Error::Database(e))),"),
 ("stale_login_ignored","infra/postgres/mod.rs","credential.password_version != record.expected_password_version || epoch != record.expected_auth_epoch || s.auth_epoch != epoch {","false {"),
 ("consume_unguarded","infra/postgres/mod.rs","AND consumed_at_ms IS NULL AND invalidated_at_ms IS NULL AND issued_at_ms<=$3","AND issued_at_ms<=$3"),
 ("backward_time_admitted","infra/postgres/mod.rs","            if now_ms < snapshot.last_seen_at_ms {\n                return Ok(Resolution::Rejected);\n            }\n",""),
 ("revoke_all_unguarded","infra/postgres/mod.rs","            if epoch != expected_epoch {\n                return Err(marker(STALE));\n            }\n",""),
 ("events_dropped","infra/postgres/mod.rs",".execute(&mut *tx).await.map_err(map)?;\n            enqueue(tx, &record.event).await",".execute(&mut *tx).await.map_err(map)?;\n            let _ = &record.event;\n            Ok(())")],
"nest":[
 ("duplicate_as_failure","infra/postgres/index.ts","e.constraint === 'n2f_identity_credentials_canonical_email_key'","false"),
 ("stale_login_ignored","infra/postgres/index.ts","        l.credential.verifiedAtMs === undefined ||\n        l.credential.passwordVersion !== record.expectedPasswordVersion ||\n        l.epoch !== record.expectedAuthEpoch\n      )\n        return rollbackWith('stale');","        l.credential.verifiedAtMs === undefined\n      )\n        return rollbackWith('stale');"),
 ("consume_unguarded","infra/postgres/index.ts"," AND consumed_at_ms IS NULL AND invalidated_at_ms IS NULL AND issued_at_ms<=$3"," AND issued_at_ms<=$3"),
 ("backward_time_admitted","infra/postgres/index.ts","            nowMs < snapshot.lastSeenAtMs ||","            false ||"),
 ("revoke_all_unguarded","infra/postgres/index.ts","      if (!locked.value || locked.value.epoch !== expectedEpoch)","      if (!locked.value)"),
 ("events_dropped","infra/postgres/index.ts","      const published = await publish(tx, [event]);\n      return published.ok ? ok('revoked' as const) : published;","      return ok('revoked' as const);")]}
originals={};hashes={}
for _,file,_,_ in MUTATIONS[LANG]:
 p=WORK/DIRS[LANG]/file
 if file not in originals:originals[file]=p.read_text();hashes[file]=hashlib.sha256(originals[file].encode()).hexdigest()
import uuid
CONTAINER=subprocess.run(["docker","compose","-p",PROJECT,"ps","-q","postgres"],stdout=subprocess.PIPE,text=True,check=True).stdout.strip()
assert CONTAINER,"bring up the check project first: N2F_POSTGRES_PORT=%d docker compose -p %s up -d --wait postgres"%(PORT,PROJECT)
def fresh_database():
 name="mut_"+uuid.uuid4().hex[:12]
 subprocess.run(["docker","exec",CONTAINER,"psql","-U","n2f","-d","n2f","-c","CREATE DATABASE "+name],check=True,stdout=subprocess.DEVNULL)
 return "postgres://n2f:n2f_local@127.0.0.1:%d/%s"%(PORT,name)
def run(name):
 p=subprocess.run(COMMANDS[LANG],cwd=WORK,env={**ENV,"N2F_TEST_DATABASE_URL":fresh_database()},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=600)
 (EVIDENCE/("store_"+name+".log")).write_text(p.stdout);return p
assert MUTATIONS[LANG],"no mutation table for "+LANG
assert run("baseline").returncode==0,str(EVIDENCE)
results=[]
for name,file,old,new in MUTATIONS[LANG]:
 path=WORK/DIRS[LANG]/file;original=originals[file]
 assert original.count(old)==1,(name,file,old)
 path.write_text(original.replace(old,new,1))
 result=run(name)
 compiled=not re.search(r"error\[E\d+\]|error TS\d+|\[build failed\]|Transform failed|Failed to load|cannot use|undefined:",result.stdout)
 caught=result.returncode!=0 and compiled and ("FAIL" in result.stdout or "panicked at" in result.stdout)
 results.append({"name":name,"file":file,"caught":caught,"compiled":compiled,"source_sha256":hashes[file]})
 path.write_text(original)
assert run("restored").returncode==0
for file,digest in hashes.items():assert hashlib.sha256((ROOT/DIRS[LANG]/file).read_bytes()).hexdigest()==digest,"original source changed"
report={"language":LANG,"caught":sum(r["caught"] for r in results),"selected":len(results),"exhaustive":False,"evidence":str(EVIDENCE),"cases":results,"logs":sorted(p.name for p in EVIDENCE.glob("store_*.log"))}
(EVIDENCE/"store-mutation-evidence.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2));assert all(r["caught"] for r in results)
