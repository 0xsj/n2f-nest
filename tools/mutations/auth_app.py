#!/usr/bin/env python3
"""Selected identity application operation mutations in isolated copies, with raw evidence."""
import hashlib,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
EVIDENCE=pathlib.Path(tempfile.mkdtemp(prefix="n2f-auth-app-mutations-"))
WORK=EVIDENCE/"work"
shutil.copytree(ROOT,WORK,ignore=shutil.ignore_patterns(".git","node_modules","target","dist","notes",".env","coverage"))
if LANG=="nest":(WORK/"node_modules").symlink_to(ROOT/"node_modules",target_is_directory=True)
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"PATH":NODE24+os.pathsep+os.environ.get("PATH",""),"GOCACHE":"/private/tmp/n2f-http-go-cache","CARGO_TARGET_DIR":"/private/tmp/n2f-identity-mutations-rs","CARGO_TERM_COLOR":"never","NO_COLOR":"1"}
DIRS={"go":"internal/identity","rs":"src/domains/identity","nest":"src/modules/identity"}
COMMANDS={"go":["go","test","-count=1","./internal/identity/app/..."],
"rs":["cargo","test","--offline","--locked","--test","identity_app_spec"],
"nest":["pnpm","exec","vitest","run","src/modules/identity/app"]}
# (name, file under the identity directory, old, new); old must occur exactly once.
MUTATIONS={
"go":[
 ("enumeration_leak","app/command/login.go","\t\tif _, e := l.deps.Hasher.VerifyAbsent(ctx, password); e != nil {\n\t\t\treturn LoginResult{}, e\n\t\t}\n",""),
 ("duplicate_replaces","app/command/register.go","\tif outcome != Created {\n\t\treturn RegisterResult{}, nil\n\t}\n","\t_ = outcome\n"),
 ("mail_after_uncertain","app/command/register.go","\tif e != nil {\n\t\treturn RegisterResult{}, e\n\t}\n\tif outcome != Created {","\tif e != nil {\n\t\t_, _ = r.deps.Mail.SendVerification(ctx, email, token, expires)\n\t\treturn RegisterResult{}, e\n\t}\n\tif outcome != Created {"),
 ("verify_without_proof","app/command/verify_email.go","\tif !matched {\n\t\treturn VerifyEmailResult{}, challengeRejected()\n\t}\n","\t_ = matched\n"),
 ("stale_as_success","app/command/login.go","\tif outcome != Committed {\n\t\treturn LoginResult{}, credentialsRejected()\n\t}\n","\t_ = outcome\n"),
 ("private_event_data","app/command/register.go",'"origin": "self_registration"}','"origin": "self_registration", "email": email.Reveal()}')],
"rs":[
 ("enumeration_leak","app/command.rs","            self.ports.verify_absent(&password).await?;\n",""),
 ("duplicate_replaces","app/command.rs","let created = outcome == RegisterOutcome::Created;","let created = true;"),
 ("mail_after_uncertain","app/command.rs","            })\n            .await?;\n        let created = outcome == RegisterOutcome::Created;","            })\n            .await\n            .unwrap_or(RegisterOutcome::Created);\n        let created = outcome == RegisterOutcome::Created;"),
 ("verify_without_proof","app/command.rs",'        if !self\n            .ports\n            .verify(&password, &found.credential.password_hash)\n            .await?\n        {\n            return Err(rejected("identity.challenge_rejected"));\n        }\n',"        let _ = &password;\n"),
 ("stale_as_success","app/command.rs",'            Commit::Stale => Err(rejected("identity.credentials_rejected")),','            Commit::Stale => Ok(LoginResult { session_id, secret: token, absolute_expires_at_ms: absolute, idle_expires_at_ms: idle, principal: found.principal }),'),
 ("private_event_data","app/command.rs",'json!({"principal_id": principal_id.to_string(), "kind": "human", "origin": "self_registration"})','json!({"principal_id": principal_id.to_string(), "kind": "human", "origin": "self_registration", "email": email.reveal()})')],
"nest":[
 ("enumeration_leak","app/command/login.ts","      const absent = await hasher.verifyAbsent(password.value);\n      if (!absent.ok) return absent;\n",""),
 ("duplicate_replaces","app/command/register.ts","    if (outcome.value !== 'created') return ok({ accepted: true, outcome: outcome.value, mailDelivered: false });\n",""),
 ("mail_after_uncertain","app/command/register.ts","    if (!outcome.ok) return outcome;\n    if (outcome.value !== 'created')","    if (!outcome.ok) {\n      await deliver(() => mail.sendVerification(email.value, token.value.secret, challenge.value.snapshot().expiresAtMs));\n      return outcome;\n    }\n    if (outcome.value !== 'created')"),
 ("verify_without_proof","app/command/verify-email.ts","    const matched = await hasher.verify(password.value, credential.passwordHash);\n    if (!matched.ok) return matched;\n    if (!matched.value) return err(challengeRejected());\n",""),
 ("stale_as_success","app/command/login.ts","    if (outcome.value !== 'committed') return err(credentialsRejected());\n",""),
 ("private_event_data","app/command/login.ts","      auth_epoch: authEpoch,\n    });","      auth_epoch: authEpoch,\n      email: credential.email.reveal(),\n    });")]}
originals={};hashes={}
for _,file,_,_ in MUTATIONS[LANG]:
 p=WORK/DIRS[LANG]/file
 if file not in originals:originals[file]=p.read_text();hashes[file]=hashlib.sha256(originals[file].encode()).hexdigest()
def run(name):
 p=subprocess.run(COMMANDS[LANG],cwd=WORK,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=600)
 (EVIDENCE/("app_"+name+".log")).write_text(p.stdout);return p
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
report={"language":LANG,"caught":sum(r["caught"] for r in results),"selected":len(results),"exhaustive":False,"evidence":str(EVIDENCE),"cases":results,"logs":sorted(p.name for p in EVIDENCE.glob("app_*.log"))}
(EVIDENCE/"app-mutation-evidence.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2));assert all(r["caught"] for r in results)
