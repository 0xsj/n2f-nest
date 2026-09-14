#!/usr/bin/env python3
"""Verify that the Redis limiter is shared by two independent HTTP processes."""
import http.client,json,os,pathlib,re,signal,subprocess,tempfile,threading,time,urllib.parse,urllib.request,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
TMP=pathlib.Path(os.environ.get("N2F_CHECK_TMP",tempfile.gettempdir()))
OFFSET={"go":0,"nest":10,"rs":20}[LANG]
PROJECT="n2f-limiter-check-"+LANG+"-"+uuid.uuid4().hex[:8]
PG_PORT=18400+OFFSET;REDIS_PORT=18401+OFFSET;SMTP_PORT=18405+OFFSET;MAILPIT_PORT=18406+OFFSET
APP_PORTS=(18430+OFFSET,18431+OFFSET)
ORIGINS=tuple("http://127.0.0.1:%d"%p for p in APP_PORTS)
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"N2F_POSTGRES_PORT":str(PG_PORT),"N2F_REDIS_PORT":str(REDIS_PORT),"N2F_SMTP_PORT":str(SMTP_PORT),"N2F_MAILPIT_UI_PORT":str(MAILPIT_PORT),"PATH":NODE24+os.pathsep+os.environ.get("PATH","")}
CSRF_KEY="verify-limiter-http-key-0123456789abcdef0123456789abcdef";PASSWORD="limiter password SENTINEL"
def run(args,env=None,timeout=600):
    r=subprocess.run(args,cwd=ROOT,env=env or ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    if r.returncode:raise RuntimeError(str(args)+"\n"+r.stdout[-8000:])
    return r.stdout
def compose(*args):return run(["docker","compose","-p",PROJECT,*args])
class Client:
    def __init__(self,port,origin):self.port=port;self.origin=origin;self.cookies={}
    def call(self,method,path,body=None,csrf=None):
        c=http.client.HTTPConnection("127.0.0.1",self.port,timeout=5);h={}
        if method!="GET":h["Origin"]=self.origin
        if csrf is not None:h["X-CSRF-Token"]=csrf
        if self.cookies:h["Cookie"]="; ".join(k+"="+v for k,v in self.cookies.items())
        data=json.dumps(body) if body is not None else None
        if data is not None:h["Content-Type"]="application/json"
        c.request(method,path,body=data,headers=h);r=c.getresponse();raw=r.read().decode()
        for k,v in r.getheaders():
            if k.lower()=="set-cookie":
                name,_,rest=v.partition("=");value=rest.split(";",1)[0]
                if "max-age=0" in v.lower():self.cookies.pop(name,None)
                else:self.cookies[name]=value
        try:doc=json.loads(raw) if raw else None
        except ValueError:doc=raw
        return r.status,dict((k.lower(),v) for k,v in r.getheaders()),doc
def mailpit(path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s"%(MAILPIT_PORT,path),timeout=5) as r:return json.load(r)
def wait_token(address):
    end=time.monotonic()+15
    while time.monotonic()<end:
        for item in mailpit("/api/v1/search?query="+urllib.parse.quote("to:"+address)).get("messages") or []:
            body=mailpit("/api/v1/message/"+item["ID"]).get("Text") or ""
            m=re.search(re.escape(ORIGINS[0]+"/verify-email")+r"#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])",body)
            if m:return m.group(1)
        time.sleep(.2)
    return None
def drain(stream,bucket):
    for line in stream:bucket.append(line)
def wait_listening(process,out,error):
    end=time.monotonic()+20
    while time.monotonic()<end:
        if any("http.listening" in line for line in out+error):return
        if process.poll() is not None:raise AssertionError("process exited before listening\n"+"".join(out[-40:])+"".join(error[-40:]))
        time.sleep(.1)
    raise AssertionError("no listener\n"+"".join(out[-40:])+"".join(error[-40:]))
def main():
    processes=[];evidence={"language":LANG,"shared_redis":False,"attempt_statuses":[]}
    try:
        compose("up","-d","--wait","postgres","mailpit","redis")
        postgres=compose("ps","-q","postgres").strip();redis=compose("ps","-q","redis").strip()
        database="limiter_"+uuid.uuid4().hex[:12]
        run(["docker","exec",postgres,"psql","-U","n2f","-d","n2f","-c","CREATE DATABASE "+database])
        if LANG=="go":
            binary=TMP/"n2f-limiter-http-go";run(["go","build","-o",str(binary),"./cmd/http-example"]);command=[str(binary)]
        elif LANG=="rs":
            target=pathlib.Path(os.environ.get("CARGO_TARGET_DIR",str(TMP/"n2f-limiter-http-rs")))
            run(["cargo","build","--offline","--locked","--target-dir",str(target),"--bin","http-example"]);command=[str(target/"debug/http-example")]
        else:
            run(["pnpm","run","build"]);command=["node","dist/http-example.js"]
        base={**ENV,"DEMO_TOKEN":"fixture-limiter-SENTINEL","AUTH_ENABLED":"true","DATABASE_ENABLED":"true","DATABASE_URL":"postgres://n2f:n2f_local@127.0.0.1:%d/%s"%(PG_PORT,database),"AUTH_DEV_INSECURE_COOKIES":"true","AUTH_COOKIE_SECURE":"false","AUTH_ALLOWED_ORIGINS":",".join(ORIGINS),"AUTH_CSRF_KEY":CSRF_KEY,"AUTH_BLOCKLIST_PATH":"config/password-blocklist.txt","AUTH_SMTP_HOST":"127.0.0.1","AUTH_SMTP_PORT":str(SMTP_PORT),"AUTH_SMTP_SECURITY":"none","AUTH_MAIL_FROM":"no-reply@n2f.local","AUTH_LINK_ORIGIN":ORIGINS[0],"HTTP_TIMEOUT_MS":"5000","LOG_FORMAT":"json","TELEMETRY_MODE":"none","SHUTDOWN_MS":"3000","EVENTS_TRANSPORT":"postgres","AUDIT_ENABLED":"false","AUTH_LIMITER":"redis","AUTH_LIMITER_REDIS_URL":"redis://127.0.0.1:%d"%REDIS_PORT,"AUTH_LIMITER_TIMEOUT_MS":"500","AUTH_LIMITER_MAX_KEYS":"100000"}
        for port in APP_PORTS:
            env={**base,"HTTP_PORT":str(port)}
            if LANG=="go":env["GOCACHE"]=str(TMP/"n2f-limiter-go-cache")
            if LANG=="rs":env["CARGO_TARGET_DIR"]=os.environ.get("CARGO_TARGET_DIR",str(TMP/"n2f-limiter-http-rs"))
            p=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            out=[];error=[];threading.Thread(target=drain,args=(p.stdout,out),daemon=True).start();threading.Thread(target=drain,args=(p.stderr,error),daemon=True).start()
            processes.append((p,out,error));wait_listening(p,out,error)
        email="limiter.%s@example.com"%uuid.uuid4().hex[:10];registration=Client(APP_PORTS[0],ORIGINS[0])
        status,_,csrf=registration.call("GET","/v1/auth/csrf");assert status==200 and csrf.get("csrf_token")
        status,_,_=registration.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD},csrf=csrf["csrf_token"]);assert status==202,status
        token=wait_token(email);assert token is not None
        status,_,csrf=registration.call("GET","/v1/auth/csrf");assert status==200
        status,_,_=registration.call("POST","/v1/auth/email/verify",{"token":token,"password":PASSWORD},csrf=csrf["csrf_token"]);assert status==204,status
        clients=[Client(APP_PORTS[0],ORIGINS[0]),Client(APP_PORTS[1],ORIGINS[1])];statuses=[]
        for index in range(11):
            client=clients[index%2];status,_,csrf=client.call("GET","/v1/auth/csrf");assert status==200 and csrf.get("csrf_token")
            status,_,_=client.call("POST","/v1/auth/login",{"email":email,"password":"wrong password"},csrf=csrf["csrf_token"]);statuses.append(status)
        assert all(status!=429 for status in statuses[:10]),statuses
        assert statuses[-1]==429,statuses
        key_list=run(["docker","exec",redis,"redis-cli","--raw","SCAN","0","MATCH","{n2f-limiter}:*","COUNT","100"])
        key_values=run(["docker","exec",redis,"redis-cli","--raw","ZRANGE","{n2f-limiter}:index","0","-1"])
        assert "{n2f-limiter}:index" in key_list and "{n2f-limiter}:counts" in key_list
        assert email not in key_values and PASSWORD not in key_values and CSRF_KEY not in key_values
        logs="".join(line for _,out,error in processes for line in out+error)
        assert "SENTINEL" not in logs and email not in logs and CSRF_KEY not in logs
        evidence["shared_redis"]=True;evidence["attempt_statuses"]=statuses;evidence["redis_key_values_are_digests"]=True
        print(json.dumps(evidence,indent=2))
    finally:
        for p,_,_ in processes:
            if p.poll() is None:p.send_signal(signal.SIGTERM)
        for p,_,_ in processes:
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        compose("down")
if __name__=="__main__":main()
