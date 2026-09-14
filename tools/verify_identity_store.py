#!/usr/bin/env python3
"""Run the identity PostgreSQL store integration tests against an owned temporary PostgreSQL 18 service."""
import json, os, pathlib, subprocess, tempfile, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
TMP=pathlib.Path(os.environ.get("N2F_CHECK_TMP",tempfile.gettempdir()))
PROJECT="n2f-check-"+LANG
PORT={"go":17921,"rs":17922,"nest":17923}[LANG]
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"N2F_POSTGRES_PORT":str(PORT),"PATH":NODE24+os.pathsep+os.environ.get("PATH","")}
def run(args,env=None,timeout=600):
    result=subprocess.run(args,cwd=ROOT,env=env or ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    if result.returncode: raise RuntimeError("command failed: "+str(args)+"\n"+result.stdout[-8000:])
    return result.stdout
def compose(*args):return run(["docker","compose","-p",PROJECT,*args])
def main():
    evidence={"language":LANG,"postgres":False,"identity_store":False}
    try:
        compose("up","-d","--wait","postgres")
        container=compose("ps","-q","postgres").strip()
        name="identity_"+uuid.uuid4().hex[:12]
        run(["docker","exec",container,"psql","-U","n2f","-d","n2f","-c","CREATE DATABASE "+name])
        evidence["postgres"]=True
        env={**ENV,"N2F_TEST_DATABASE_URL":"postgres://n2f:n2f_local@127.0.0.1:"+str(PORT)+"/"+name}
        if LANG=="go":
            env["GOCACHE"]=str(TMP/"n2f-http-go-cache")
            out=run(["go","test","-race","-count=1","./internal/identity/infra/postgres","-v"],env)
        elif LANG=="rs":
            target=os.environ.get("CARGO_TARGET_DIR",str(TMP/"n2f-http-rs"))
            out=run(["cargo","test","--offline","--locked","--target-dir",target,"--test","identity_store_integration","--","--ignored"],env)
        else:
            out=run(["pnpm","exec","vitest","run","src/modules/identity/infra/postgres/integration.spec.ts"],env)
        evidence["identity_store"]=True
        evidence["summary"]=[l for l in out.splitlines() if l.startswith(("ok","test result","      Tests","--- PASS","--- FAIL","FAIL"))][-12:]
        assert "SENTINEL" not in out and env["N2F_TEST_DATABASE_URL"] not in out
        evidence["redaction"]=True
        print(json.dumps(evidence,indent=2))
    finally:
        compose("down")
if __name__=="__main__":main()
