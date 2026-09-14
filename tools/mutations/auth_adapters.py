#!/usr/bin/env python3
"""Selected password-hash and token-codec adapter mutations in isolated copies, with raw evidence."""
import hashlib,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
EVIDENCE=pathlib.Path(tempfile.mkdtemp(prefix="n2f-auth-adapter-mutations-"))
WORK=EVIDENCE/"work"
shutil.copytree(ROOT,WORK,ignore=shutil.ignore_patterns(".git","node_modules","target","dist","notes",".env","coverage"))
if LANG=="nest":(WORK/"node_modules").symlink_to(ROOT/"node_modules",target_is_directory=True)
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"PATH":NODE24+os.pathsep+os.environ.get("PATH",""),"GOCACHE":"/private/tmp/n2f-http-go-cache","CARGO_TARGET_DIR":"/private/tmp/n2f-identity-mutations-rs","CARGO_TERM_COLOR":"never","NO_COLOR":"1"}
DIRS={"go":"internal/identity","rs":"src/domains/identity","nest":"src/modules/identity"}
COMMANDS={"go":["go","test","-count=1","./internal/identity/passwordhash","./internal/identity/tokencodec"],
"rs":["cargo","test","--offline","--locked","--test","password_hash_spec","--test","token_codec_spec"],
"nest":["pnpm","exec","vitest","run","src/modules/identity/password-hash","src/modules/identity/token-codec"]}
# (name, file under the identity directory, old, new); old must occur exactly once.
MUTATIONS={
"go":[
 ("allowlist_memory","passwordhash/hasher.go","!strings.HasPrefix(record, prefix)","false"),
 ("mismatch_as_corrupt","passwordhash/hasher.go","if subtle.ConstantTimeCompare(got, want) == 1 {\n\t\treturn Match, nil\n\t}\n\treturn Mismatch, nil","if subtle.ConstantTimeCompare(got, want) == 1 {\n\t\treturn Match, nil\n\t}\n\treturn Mismatch, corrupt()"),
 ("dummy_leaks","passwordhash/hasher.go","_ = subtle.ConstantTimeCompare(got, want)\n\treturn Mismatch, nil","if subtle.ConstantTimeCompare(got, want) == 1 {\n\t\treturn Match, nil\n\t}\n\treturn Mismatch, nil"),
 ("saturation_ignored","passwordhash/hasher.go","if h.queued >= h.limits.MaxQueued {","if false {"),
 ("digest_purpose_binding","tokencodec/codec.go","h.Write([]byte(purpose))\n\th.Write([]byte{0})\n",""),
 ("noncanonical_accept","tokencodec/codec.go"," || b64.EncodeToString(raw) != text",""),
 ("entropy_fallback","tokencodec/codec.go",'return Issued{}, fault(faults.Unavailable, "entropy unavailable for token", "entropy_unavailable")',"_ = e")],
"rs":[
 ("allowlist_memory","password_hash/mod.rs",'|| fields[2] != "m=19456,t=2,p=1"','|| !fields[2].ends_with(",t=2,p=1")'),
 ("mismatch_as_corrupt","password_hash/mod.rs","        } else {\n            Outcome::Mismatch\n        })","        } else {\n            return Err(corrupt());\n        })"),
 ("dummy_leaks","password_hash/mod.rs","let _discarded = bool::from(computed.ct_eq(&stored));\n        Ok(Outcome::Mismatch)","Ok(if bool::from(computed.ct_eq(&stored)) {\n            Outcome::Match\n        } else {\n            Outcome::Mismatch\n        })"),
 ("saturation_ignored","password_hash/mod.rs","if position >= self.limits.max_queued {","if false {"),
 ("digest_purpose_binding","token_codec/mod.rs","    hasher.update(purpose.as_str().as_bytes());\n    hasher.update([0u8]);\n",""),
 ("noncanonical_accept","token_codec/mod.rs","URL_SAFE_NO_PAD.decode(text).map_err(|_| invalid())?;\n        let raw: [u8; TOKEN_BYTES] = decoded.try_into().map_err(|_| invalid())?;\n        if URL_SAFE_NO_PAD.encode(raw) != text {","base64::engine::GeneralPurpose::new(&base64::alphabet::URL_SAFE, base64::engine::GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone).with_decode_allow_trailing_bits(true)).decode(text).map_err(|_| invalid())?;\n        let raw: [u8; TOKEN_BYTES] = decoded.try_into().map_err(|_| invalid())?;\n        if false {"),
 ("entropy_fallback","token_codec/mod.rs",'entropy.fill(&mut raw).map_err(|source| {\n            Failure::new(Kind::Unavailable, "entropy unavailable")\n                .with_type("identity.entropy_unavailable")\n                .with_boxed_source(source)\n        })?;','let _ = entropy.fill(&mut raw);')],
"nest":[
 ("allowlist_memory","password-hash/phc.ts","    fields[3] !==\n      `m=${FORMAT.memory},t=${FORMAT.passes},p=${FORMAT.parallelism}`","    !/^m=\\d+,t=2,p=1$/.test(fields[3])"),
 ("mismatch_as_corrupt","password-hash/hasher.ts","    return ok(\n      timingSafeEqual(tag.value, parsed.value.tag) ? 'match' : 'mismatch',\n    );","    if (!timingSafeEqual(tag.value, parsed.value.tag)) return err(corrupt());\n    return ok('match');"),
 ("dummy_leaks","password-hash/hasher.ts","    timingSafeEqual(tag.value, parsed.value.tag);\n    return ok('mismatch');","    return ok(timingSafeEqual(tag.value, parsed.value.tag) ? 'match' : 'mismatch');"),
 ("saturation_ignored","password-hash/admission.ts","if (this.#queue.length >= this.limits.maxQueued)","if (false)"),
 ("digest_purpose_binding","token-codec/index.ts","      .update(purpose, 'utf8')\n      .update(Uint8Array.of(0))\n",""),
 ("noncanonical_accept","token-codec/index.ts","raw.length !== TOKEN_BYTES || raw.toString('base64url') !== secret","raw.length !== TOKEN_BYTES"),
 ("entropy_fallback","token-codec/index.ts","      this.#entropy(raw);\n    } catch (cause) {\n      return err(","      this.#entropy(raw);\n    } catch (cause) {\n      raw.fill(0);\n      if (cause === undefined) return err(")]}
originals={};hashes={}
for _,file,_,_ in MUTATIONS[LANG]:
 p=WORK/DIRS[LANG]/file
 if file not in originals:originals[file]=p.read_text();hashes[file]=hashlib.sha256(originals[file].encode()).hexdigest()
def run(name):
 p=subprocess.run(COMMANDS[LANG],cwd=WORK,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=600)
 (EVIDENCE/("adapters_"+name+".log")).write_text(p.stdout);return p
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
report={"language":LANG,"caught":sum(r["caught"] for r in results),"selected":len(results),"exhaustive":False,"evidence":str(EVIDENCE),"cases":results,"logs":sorted(p.name for p in EVIDENCE.glob("adapters_*.log"))}
(EVIDENCE/"adapter-mutation-evidence.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2));assert all(r["caught"] for r in results)
