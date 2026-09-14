#!/usr/bin/env python3
"""Verify audit ingestion and its authenticated read projection against PostgreSQL and JetStream."""
import http.client,json,os,pathlib,re,signal,subprocess,tempfile,threading,time,urllib.parse,urllib.request,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
TMP=pathlib.Path(os.environ.get("N2F_CHECK_TMP",tempfile.gettempdir()))
OFFSET={"go":0,"nest":10,"rs":20}[LANG]
PROJECT="n2f-audit-check-"+LANG+"-"+uuid.uuid4().hex[:8]
PG_PORT=18300+OFFSET;NATS_PORT=18302+OFFSET;SMTP_PORT=18305+OFFSET;MAILPIT_PORT=18306+OFFSET
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"N2F_POSTGRES_PORT":str(PG_PORT),"N2F_NATS_PORT":str(NATS_PORT),"N2F_NATS_MONITOR_PORT":str(NATS_PORT+1),"N2F_SMTP_PORT":str(SMTP_PORT),"N2F_MAILPIT_UI_PORT":str(MAILPIT_PORT),"PATH":NODE24+os.pathsep+os.environ.get("PATH","")}
ORIGIN="http://127.0.0.1:18330";CSRF_KEY="verify-audit-http-key-0123456789abcdef0123456789abcdef";PASSWORD="audit password SENTINEL"
def run(args,env=None,timeout=600):
    r=subprocess.run(args,cwd=ROOT,env=env or ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    if r.returncode:raise RuntimeError(str(args)+"\n"+r.stdout[-8000:])
    return r.stdout
def compose(*args):return run(["docker","compose","-p",PROJECT,*args])
class Client:
    def __init__(self):self.cookies={}
    def call(self,method,path,body=None,csrf=None,cookies=True):
        c=http.client.HTTPConnection("127.0.0.1",int(urllib.parse.urlsplit(ORIGIN).port),timeout=5);headers={}
        if method!="GET":headers["Origin"]=ORIGIN
        if csrf is not None:headers["X-CSRF-Token"]=csrf
        if cookies and self.cookies:headers["Cookie"]="; ".join(k+"="+v for k,v in self.cookies.items())
        data=json.dumps(body) if body is not None else None
        if data is not None:headers["Content-Type"]="application/json"
        c.request(method,path,body=data,headers=headers);r=c.getresponse();raw=r.read().decode()
        for h,v in r.getheaders():
            if h.lower()=="set-cookie":
                name,_,rest=v.partition("=");value=rest.split(";",1)[0]
                if "max-age=0" in v.lower():self.cookies.pop(name,None)
                else:self.cookies[name]=value
        try:doc=json.loads(raw) if raw else None
        except ValueError:doc=raw
        return r.status,dict((h.lower(),v) for h,v in r.getheaders()),doc
def mailpit(path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s"%(MAILPIT_PORT,path),timeout=5) as r:return json.load(r)
def wait_token(address):
    end=time.monotonic()+15
    while time.monotonic()<end:
        found=mailpit("/api/v1/search?query="+urllib.parse.quote("to:"+address))
        for item in found.get("messages") or []:
            message=mailpit("/api/v1/message/"+item["ID"]);text=message.get("Text") or ""
            match=re.search(re.escape(ORIGIN+"/verify-email")+r"#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])",text)
            if match:return match.group(1)
        time.sleep(.2)
    return None
def main():
    process=None;evidence={"language":LANG,"transports":[]}
    try:
        compose("up","-d","--wait","postgres","mailpit","nats")
        container=compose("ps","-q","postgres").strip()
        if LANG=="go":
            binary=TMP/"n2f-audit-http-go";run(["go","build","-o",str(binary),"./cmd/http-example"]);command=[str(binary)]
        elif LANG=="rs":
            target=os.environ.get("CARGO_TARGET_DIR",str(TMP/"n2f-audit-http-rs"));run(["cargo","build","--offline","--locked","--target-dir",target,"--bin","http-example"]);command=[str(pathlib.Path(target)/"debug/http-example")]
        else:
            run(["pnpm","run","build"]);command=["node","dist/http-example.js"]
        for transport in ("postgres","jetstream"):
            name="audit_"+transport+"_"+uuid.uuid4().hex[:12]
            run(["docker","exec",container,"psql","-U","n2f","-d","n2f","-c","CREATE DATABASE "+name])
            stream="AUDIT_"+uuid.uuid4().hex[:16]
            env={**ENV,"DEMO_TOKEN":"fixture-audit-SENTINEL","AUTH_ENABLED":"true","DATABASE_ENABLED":"true","DATABASE_URL":"postgres://n2f:n2f_local@127.0.0.1:%d/%s"%(PG_PORT,name),"AUTH_DEV_INSECURE_COOKIES":"true","AUTH_COOKIE_SECURE":"false","AUTH_ALLOWED_ORIGINS":ORIGIN,"AUTH_CSRF_KEY":CSRF_KEY,"AUTH_BLOCKLIST_PATH":"config/password-blocklist.txt","AUTH_SMTP_HOST":"127.0.0.1","AUTH_SMTP_PORT":str(SMTP_PORT),"AUTH_SMTP_SECURITY":"none","AUTH_MAIL_FROM":"no-reply@n2f.local","AUTH_LINK_ORIGIN":ORIGIN,"HTTP_PORT":str(18330),"HTTP_TIMEOUT_MS":"5000","LOG_FORMAT":"json","TELEMETRY_MODE":"none","SHUTDOWN_MS":"3000","EVENTS_TRANSPORT":transport,"AUDIT_ENABLED":"true","AUDIT_CONSUMER":"audit"}
            if transport=="jetstream":env.update({"NATS_URL":"nats://127.0.0.1:"+str(NATS_PORT),"NATS_STREAM":stream,"NATS_CONSUMER":"mailbox"})
            if LANG=="go":env["GOCACHE"]=str(TMP/"n2f-audit-go-cache")
            if LANG=="rs":env["CARGO_TARGET_DIR"]=os.environ.get("CARGO_TARGET_DIR",str(TMP/"n2f-audit-http-rs"))
            process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            out=[];err=[]
            threading.Thread(target=lambda:[out.append(line) for line in process.stdout],daemon=True).start()
            threading.Thread(target=lambda:[err.append(line) for line in process.stderr],daemon=True).start()
            try:
                end=time.monotonic()+20
                while time.monotonic()<end and not any("http.listening" in line for line in out+err):
                    if process.poll() is not None:
                        time.sleep(.2)
                        raise AssertionError("process exited before listening\n"+"".join(out[-40:])+"".join(err[-40:]))
                    time.sleep(.1)
                assert any("http.listening" in line for line in out+err),"no listener"
                client=Client();anonymous=Client()
                status,headers,csrf=client.call("GET","/v1/auth/csrf");assert status==200 and csrf.get("csrf_token")
                token=csrf["csrf_token"];email="audit.%s@example.com"%uuid.uuid4().hex[:10]
                status,_,_=client.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD},csrf=token);assert status==202
                verify_token=wait_token(email);assert verify_token is not None
                status,_,csrf=client.call("GET","/v1/auth/csrf");token=csrf["csrf_token"]
                status,_,_=client.call("POST","/v1/auth/email/verify",{"token":verify_token,"password":PASSWORD},csrf=token);assert status==204
                status,_,login=client.call("POST","/v1/auth/login",{"email":email,"password":PASSWORD},csrf=token);assert status==200
                principal=login["principal_id"]
                status,_,_=anonymous.call("GET","/v1/audit/records");assert status==401
                status,_,_=client.call("GET","/v1/audit/records?limit=101");assert status==400
                records=[];end=time.monotonic()+15
                while time.monotonic()<end:
                    status,headers,body=client.call("GET","/v1/audit/records?limit=100")
                    if status==200:records=body.get("records") or []
                    actions={r.get("action") for r in records};expected={"identity.principal.registered.v1","identity.email.verified.v1","identity.session.created.v1"}
                    if expected.issubset(actions):break
                    time.sleep(.2)
                diagnostic={"outbox":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM n2f_outbox"]),"outbox_envelopes":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT envelope FROM n2f_outbox ORDER BY event_id"]),"mailbox":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM n2f_mailbox"]),"audit":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM n2f_audit_records"]),"receipts":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT consumer,state,count(*) FROM n2f_mailbox_receipts GROUP BY consumer,state"]),"logs":"".join(line for line in out+err if "audit.worker" in line)}
                assert {r.get("action") for r in records}.issuperset(expected),(status,body,diagnostic)
                selected=[r for r in records if r.get("action") in expected]
                assert all(r.get("subject_id")==principal and isinstance(r.get("occurred_at_ms"),int) and isinstance(r.get("recorded_at_ms"),int) for r in selected)
                assert any(r.get("occurred_at_ms") != r.get("recorded_at_ms") for r in selected)
                assert headers.get("cache-control")=="no-store"
                receipt_count=run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM n2f_mailbox_receipts WHERE consumer='audit' AND state='processed'"]).strip()
                assert int(receipt_count)>=len(expected),receipt_count
                response=json.dumps(records)
                assert email not in response and PASSWORD not in response
                text="".join(out+err)
                assert "SENTINEL" not in text and email not in text and CSRF_KEY not in text and env["DATABASE_URL"] not in text
                evidence["transports"].append({"transport":transport,"actions":sorted(actions),"processed_audit_receipts":int(receipt_count)})
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:process.wait(timeout=5)
                    except subprocess.TimeoutExpired:process.kill();process.wait()
                process=None
        print(json.dumps(evidence,indent=2))
    finally:
        if process and process.poll() is None:process.kill();process.wait()
        compose("down")
if __name__=="__main__":main()
