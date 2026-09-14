#!/usr/bin/env python3
"""Run selected Redis limiter mutations in isolated copies with the live two-process proof."""
import hashlib,json,os,pathlib,re,shutil,subprocess,tempfile

ROOT=pathlib.Path(__file__).resolve().parents[2]
LANG="nest"
EVIDENCE=pathlib.Path(tempfile.mkdtemp(prefix="n2f-limiter-mutations-"))
WORK=EVIDENCE/"work"
shutil.copytree(ROOT,WORK,ignore=shutil.ignore_patterns(".git","node_modules","target","dist","notes",".env","coverage"))
(WORK/"node_modules").symlink_to(ROOT/"node_modules",target_is_directory=True)
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"PATH":NODE24+os.pathsep+os.environ.get("PATH",""),"NO_COLOR":"1"}
MUTATIONS=[
    ("subject_threshold_bypassed", "src/modules/identity/infra/redis/limiter.ts", "String(attempts),", "String(100),"),
    ("subject_digest_replaced_with_raw", "src/modules/identity/infra/redis/limiter.ts", "      Buffer.from(signed.value).toString('hex'),\n      String(attempts),", "      subject.reveal(),\n      String(attempts),"),
    ("boundary_comparison_shifted", "src/modules/identity/infra/redis/limiter.ts", "if count > attempts then", "if count >= attempts then"),
]
COMMAND=["python3","tools/verify_limiter.py"]
COMPILE_ERROR=re.compile(r"error TS\d+|error: could not compile|\[build failed\]|Transform failed|Failed to compile|cannot find module", re.I)

originals={};hashes={}
for _,file,_,_ in MUTATIONS:
    path=WORK/file
    if file not in originals:
        originals[file]=path.read_text();hashes[file]=hashlib.sha256(originals[file].encode()).hexdigest()

def run(name):
    env={**ENV,"N2F_CHECK_TMP":str(EVIDENCE/"checks"/name)}
    result=subprocess.run(COMMAND,cwd=WORK,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=900)
    (EVIDENCE/(name+".log")).write_text(result.stdout)
    return result

baseline=run("baseline")
assert baseline.returncode==0,("baseline failed",str(EVIDENCE))
results=[]
for name,file,old,new in MUTATIONS:
    path=WORK/file;original=originals[file]
    assert original.count(old)==1,(name,file,old)
    path.write_text(original.replace(old,new,1))
    try:
        result=run(name)
    finally:
        path.write_text(original)
    compiled=not COMPILE_ERROR.search(result.stdout)
    caught=result.returncode!=0 and compiled and ("AssertionError" in result.stdout or "Traceback" in result.stdout)
    results.append({"name":name,"file":file,"caught":caught,"compiled":compiled,"source_sha256":hashes[file]})
restored=run("restored")
assert restored.returncode==0,("restored baseline failed",str(EVIDENCE))
for file,digest in hashes.items():
    assert hashlib.sha256((ROOT/file).read_bytes()).hexdigest()==digest,("original source changed",file)
report={"language":LANG,"caught":sum(r["caught"] for r in results),"selected":len(results),"exhaustive":False,"evidence":str(EVIDENCE),"cases":results}
(EVIDENCE/"limiter-mutation-evidence.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
assert all(r["caught"] for r in results)
