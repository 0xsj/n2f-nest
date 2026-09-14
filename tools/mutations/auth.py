#!/usr/bin/env python3
"""Selected auth leaf mutations (AUTHENTICATION.md milestone faults) in isolated copies, with raw evidence."""
import hashlib,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
EVIDENCE=pathlib.Path(tempfile.mkdtemp(prefix="n2f-auth-mutations-"))
WORK=EVIDENCE/"work"
shutil.copytree(ROOT,WORK,ignore=shutil.ignore_patterns(".git","node_modules","target","dist","notes",".env","coverage"))
if LANG=="nest":(WORK/"node_modules").symlink_to(ROOT/"node_modules",target_is_directory=True)
ENV={**os.environ,"GOCACHE":"/private/tmp/n2f-http-go-cache","CARGO_TARGET_DIR":"/private/tmp/n2f-identity-mutations-rs","CARGO_TERM_COLOR":"never","NO_COLOR":"1"}
DIRS={"go":"internal/identity/domain","rs":"src/domains/identity/domain","nest":"src/modules/identity/domain"}
COMMANDS={"go":["go","test","-count=1","-run","TestAuth","./internal/identity/domain"],"rs":["cargo","test","--offline","--locked","--test","auth_leaves_spec"],"nest":["pnpm","exec","vitest","run","src/modules/identity/domain/auth.spec.ts"]}
# (name, file under the domain directory, old, new); old must occur exactly once.
MUTATIONS={
"go":[
 ("expiry_equality","session.go","now >= s.state.IdleExpiresAtMS ||","now > s.state.IdleExpiresAtMS ||"),
 ("purpose_confusion","challenge.go","purpose != s.TokenDigest.purpose ||","false ||"),
 ("replay","challenge.go","s.ConsumedAtMS != nil || s.InvalidatedAtMS != nil ||","s.InvalidatedAtMS != nil ||"),
 ("stale_version","challenge.go","passwordVersion != s.PasswordVersion ||","false ||"),
 ("revocation_check","session.go","s.state.RevokedAtMS != nil || now < s.state.LastSeenAtMS","now < s.state.LastSeenAtMS"),
 ("secret_disclosure","email.go",'func (Email) String() string               { return "[REDACTED]" }','func (e Email) String() string { return e.value }')],
"rs":[
 ("expiry_equality","session.rs","|| now >= s.idle_expires_at_ms","|| now > s.idle_expires_at_ms"),
 ("purpose_confusion","challenge.rs","if purpose != s.token_digest.purpose()","if false"),
 ("replay","challenge.rs","|| s.consumed_at_ms.is_some()","|| false"),
 ("stale_version","challenge.rs","|| version != s.password_version","|| false"),
 ("revocation_check","session.rs","if s.revoked_at_ms.is_some()","if false"),
 ("secret_disclosure","email.rs",'impl std::fmt::Display for Email {\n    fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {\n        f.write_str("[REDACTED]")','impl std::fmt::Display for Email {\n    fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {\n        f.write_str(&self.value)')],
"nest":[
 ("expiry_equality","session.ts","if (now >= s.idleExpiresAtMs || now >= s.absoluteExpiresAtMs)","if (now > s.idleExpiresAtMs || now >= s.absoluteExpiresAtMs)"),
 ("purpose_confusion","challenge.ts","if (purpose !== s.tokenDigest.purpose()) return err(rejected());","if (false) return err(rejected());"),
 ("replay","challenge.ts","if (s.consumedAtMs !== undefined || s.invalidatedAtMs !== undefined)","if (s.invalidatedAtMs !== undefined)"),
 ("stale_version","challenge.ts","if (version !== s.passwordVersion) return err(rejected());","if (false) return err(rejected());"),
 ("revocation_check","session.ts","if (s.revokedAtMs !== undefined) return err(rejected());","if (false) return err(rejected());"),
 ("secret_disclosure","email.ts","  private constructor(value: string) {\n    super(value);\n  }","  private constructor(value: string) {\n    super(value);\n  }\n  toJSON(): string {\n    return this.reveal();\n  }")]}
originals={};hashes={}
for _,file,_,_ in MUTATIONS[LANG]:
 p=WORK/DIRS[LANG]/file
 if file not in originals:originals[file]=p.read_text();hashes[file]=hashlib.sha256(originals[file].encode()).hexdigest()
def run(name):
 p=subprocess.run(COMMANDS[LANG],cwd=WORK,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=300)
 (EVIDENCE/("auth_"+name+".log")).write_text(p.stdout);return p
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
report={"language":LANG,"caught":sum(r["caught"] for r in results),"selected":len(results),"exhaustive":False,"evidence":str(EVIDENCE),"cases":results,"logs":sorted(p.name for p in EVIDENCE.glob("auth_*.log"))}
(EVIDENCE/"auth-mutation-evidence.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2));assert all(r["caught"] for r in results)
