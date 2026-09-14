#!/usr/bin/env python3
"""Selected identity SMTP mail delivery and challenge-request mutations in isolated copies, with raw evidence."""
import hashlib,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
EVIDENCE=pathlib.Path(tempfile.mkdtemp(prefix="n2f-auth-mail-mutations-"))
WORK=EVIDENCE/"work"
shutil.copytree(ROOT,WORK,ignore=shutil.ignore_patterns(".git","node_modules","target","dist","notes",".env","coverage"))
if LANG=="nest":(WORK/"node_modules").symlink_to(ROOT/"node_modules",target_is_directory=True)
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"PATH":NODE24+os.pathsep+os.environ.get("PATH",""),"GOCACHE":"/private/tmp/n2f-http-go-cache","CARGO_TARGET_DIR":"/private/tmp/n2f-identity-mutations-rs","CARGO_TERM_COLOR":"never","NO_COLOR":"1"}
DIRS={"go":".","rs":".","nest":"."}
COMMANDS={"go":["go","test","-count=1","-timeout","45s","./internal/identity/app/...","./internal/identity/infra/smtp/..."],
"rs":["cargo","test","--offline","--locked","--test","identity_app_spec","--test","identity_smtp_spec"],
"nest":["pnpm","exec","vitest","run","src/modules/identity/app","src/modules/identity/infra/smtp"]}
# (name, file under the identity directory, old, new); old must occur exactly once.
MUTATIONS={
"go":[["token_in_query", "internal/identity/infra/smtp/mailer.go", "link := m.cfg.LinkOrigin + path + \"#token=\" + token.Reveal()", "link := m.cfg.LinkOrigin + path + \"?token=\" + token.Reveal()"], ["delivered_on_rejection", "internal/identity/infra/smtp/mailer.go", "\tif e = w.Close(); e != nil {\n\t\treturn classify(ctx, e)\n\t}", "\t_ = w.Close()"], ["timeout_ignored", "internal/identity/infra/smtp/mailer.go", "ctx, cancel := context.WithTimeout(parent, m.cfg.Timeout)", "ctx, cancel := context.WithCancel(parent)"], ["token_in_log", "internal/identity/infra/smtp/mailer.go", "\"identity.mail.attempted\", \"kind\", kind,", "\"identity.mail.attempted\", \"link\", m.cfg.LinkOrigin+\"#token=\"+token.Reveal(), \"kind\", kind,"], ["expiry_omitted", "internal/identity/infra/smtp/mailer.go", "expiry := time.UnixMilli(expiresAtMS).UTC().Format(time.RFC3339)", "expiry := \"\""], ["suspended_gets_mail", "internal/identity/app/command/request_challenge.go", "record.Principal.Status != d.Active || ", ""]],
"rs":[["token_in_query", "src/domains/identity/infra/smtp/mod.rs", "let link = format!(\"{}{}#token={}\", self.link_origin, path, token.reveal());", "let link = format!(\"{}{}?token={}\", self.link_origin, path, token.reveal());"], ["delivered_on_rejection", "src/domains/identity/infra/smtp/mod.rs", "            Err(e) if e.is_permanent() || e.is_transient() => Err(\"refused\"),", "            Err(e) if e.is_permanent() || e.is_transient() => Ok(()),"], ["timeout_ignored", "src/domains/identity/infra/smtp/mod.rs", "            timeout: Duration::from_millis(config.timeout_ms as u64),", "            timeout: Duration::from_secs(3600),"], ["token_in_log", "src/domains/identity/infra/smtp/mod.rs", "                (\"kind\".into(), kind.into()),", "                (\"kind\".into(), kind.into()),\n                (\"token\".into(), token.reveal().into()),"], ["expiry_omitted", "src/domains/identity/infra/smtp/mod.rs", "            \"{purpose}\\n\\n{link}\\n\\nThe link expires at {}. {ignore}\\n\",\n            iso8601(expires_at_ms)\n", "            \"{purpose}\\n\\n{link}\\n\\n{ignore}\\n\",\n"], ["suspended_gets_mail", "src/domains/identity/app/command.rs", "    // response stays accepted so suspension is not disclosed.\n    if found.principal.status != Status::Active {\n        return Ok(none);\n    }\n", "    // response stays accepted so suspension is not disclosed.\n"]],
"nest":[["token_in_query", "src/modules/identity/infra/smtp/index.ts", "'#token=' +", "'?token=' +"], ["delivered_on_rejection", "src/modules/identity/infra/smtp/index.ts", "if (typeof responseCode === 'number') return 'refused';", "if (typeof responseCode === 'number') return 'delivered';"], ["timeout_ignored", "src/modules/identity/infra/smtp/index.ts", "this.#budget = settings.timeoutMs;", "this.#budget = 60_000;"], ["token_in_log", "src/modules/identity/infra/smtp/index.ts", "const text = body(kind, link, expires.toISOString());", "const text = body(kind, link, expires.toISOString());\n    this.#log.info('identity.mail.link', { link });"], ["expiry_omitted", "src/modules/identity/infra/smtp/index.ts", "`This link expires at ${expiresAt}.`,", ""], ["suspended_gets_mail", "src/modules/identity/app/command/request-challenge.ts", "    if (found.value.principal.status !== 'active')\n      return ok({ accepted: true, outcome: 'inactive', mailDelivered: false });\n", ""]]}
originals={};hashes={}
for _,file,_,_ in MUTATIONS[LANG]:
 p=WORK/DIRS[LANG]/file
 if file not in originals:originals[file]=p.read_text();hashes[file]=hashlib.sha256(originals[file].encode()).hexdigest()
def run(name):
 p=subprocess.run(COMMANDS[LANG],cwd=WORK,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=600)
 (EVIDENCE/("mail_"+name+".log")).write_text(p.stdout);return p
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
report={"language":LANG,"caught":sum(r["caught"] for r in results),"selected":len(results),"exhaustive":False,"evidence":str(EVIDENCE),"cases":results,"logs":sorted(p.name for p in EVIDENCE.glob("mail_*.log"))}
(EVIDENCE/"mail-mutation-evidence.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2));assert all(r["caught"] for r in results)
