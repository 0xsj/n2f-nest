#!/usr/bin/env python3
"""Real PostgreSQL/JetStream replacement and restart checks, owned by this clone."""
import base64,json,os,pathlib,socket,subprocess,tempfile,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
OFFSET={"go":0,"nest":10,"rs":20}[LANG]
PROJECT="n2f-jetstream-check-"+LANG+"-"+uuid.uuid4().hex[:8]
ENV={**os.environ,"N2F_POSTGRES_PORT":str(18200+OFFSET),"N2F_NATS_PORT":str(18201+OFFSET),"N2F_NATS_MONITOR_PORT":str(18202+OFFSET)}
TMP=pathlib.Path(os.environ.get("N2F_CHECK_TMP",tempfile.gettempdir()))
def run(command,env=None,ok=True,timeout=240):
    p=subprocess.run(command,cwd=ROOT,env=env or ENV,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
    if ok and p.returncode:raise AssertionError(str(command)+"\n"+p.stdout[-8000:])
    return p
def compose(*args):return run(["docker","compose","-p",PROJECT,*args]).stdout
def api(subject,data):
    payload=json.dumps(data,separators=(",",":")).encode()
    with socket.create_connection(("127.0.0.1",18201+OFFSET),timeout=3) as s:
        f=s.makefile("rb");assert f.readline().startswith(b"INFO ")
        s.sendall(b'CONNECT {"verbose":false,"pedantic":false}\r\nSUB _INBOX.check 1\r\nPUB '+subject.encode()+b' _INBOX.check '+str(len(payload)).encode()+b'\r\n'+payload+b'\r\n')
        while True:
            line=f.readline()
            if line==b"PING\r\n":s.sendall(b"PONG\r\n");continue
            if line.startswith(b"-ERR"):raise AssertionError(line)
            if line.startswith(b"MSG "):
                body=f.read(int(line.split()[-1]));assert f.read(2)==b"\r\n";result=json.loads(body)
                assert "error" not in result,result
                return result
            assert line,"broker closed"
def main():
    evidence={"language":LANG,"cases":[]}
    try:
        compose("up","-d","--wait","postgres","nats")
        container=compose("ps","-q","postgres").strip()
        def database():
            name="js_"+uuid.uuid4().hex[:16]
            run(["docker","exec",container,"psql","-U","n2f","-d","n2f","-c","CREATE DATABASE "+name])
            return "postgres://n2f:n2f_local@127.0.0.1:"+ENV["N2F_POSTGRES_PORT"]+"/"+name
        env={**ENV,"N2F_TEST_DATABASE_URL":database(),"N2F_TEST_NATS_URL":"nats://127.0.0.1:"+ENV["N2F_NATS_PORT"],"N2F_TEST_NATS_STREAM":"CHECK_"+uuid.uuid4().hex[:16],"GOCACHE":str(TMP/"n2f-http-go-cache"),"CARGO_TARGET_DIR":str(TMP/"n2f-http-rs")}
        if LANG=="go":
            run(["go","test","-race","./pkg/events/jetstream","-v"],env)
            binary=str(TMP/"n2f-events-go");run(["go","build","-o",binary,"./cmd/events-example"],env);command=[binary]
        elif LANG=="rs":
            run(["cargo","test","--offline","--locked","--test","jetstream_integration","--","--ignored"],env)
            run(["cargo","build","--offline","--locked","--bin","events-example"],env);command=[env["CARGO_TARGET_DIR"]+"/debug/events-example"]
        else:
            run(["pnpm","exec","vitest","run","src/shared/events/jetstream/integration.spec.ts"],env)
            run(["pnpm","run","build"],env);command=["node","dist/events-example.js"]
        evidence["cases"].append("unchanged_dispatcher_real_broker_and_mailbox")
        stream=env["N2F_TEST_NATS_STREAM"]
        info=api("$JS.API.STREAM.INFO."+stream,{})
        assert info["state"]["messages"]==2  # one deduplicated event plus the 64 KiB boundary event
        evidence["cases"].append("lost_outbox_ack_deduplicated_in_stream")
        demo={**env,"DATABASE_URL":database(),"DEMO_TOKEN":"credential-SENTINEL","LOG_FORMAT":"json","NATS_URL":env["N2F_TEST_NATS_URL"],"NATS_STREAM":"DEMO_"+uuid.uuid4().hex[:16],"NATS_CONSUMER":"mailbox","EVENTS_TRANSPORT":"postgres"}
        def example(success=True):
            p=run(command,demo,ok=success,timeout=20)
            assert "SENTINEL" not in p.stdout and demo["DATABASE_URL"] not in p.stdout and demo["NATS_URL"] not in p.stdout
            if success:
                assert p.returncode==0 and sum(json.loads(l).get("message")=="events.example.completed" for l in p.stdout.splitlines() if l.startswith("{"))==1,p.stdout
            else:assert p.returncode!=0,p.stdout
        example();evidence["cases"].append("postgres_root_selection")
        demo["EVENTS_TRANSPORT"]="jetstream";example();evidence["cases"].append("jetstream_root_selection")
        saved=api("$JS.API.STREAM.INFO."+demo["NATS_STREAM"],{})["config"]
        incompatible={**saved,"max_msg_size":32768}
        api("$JS.API.STREAM.UPDATE."+demo["NATS_STREAM"],incompatible);example(False)
        assert api("$JS.API.STREAM.INFO."+demo["NATS_STREAM"],{})["config"]["max_msg_size"]==32768
        api("$JS.API.STREAM.UPDATE."+demo["NATS_STREAM"],saved)
        evidence["cases"].append("incompatible_stream_refuses_without_rewriting")
        stream=demo["NATS_STREAM"]
        fixture=ROOT/("pkg" if LANG=="go" else "src/shared")/"events/fixtures/envelope.json"
        pending=json.loads(fixture.read_text());ack=api("n2f.events."+stream,pending)
        before=api("$JS.API.STREAM.MSG.GET."+stream,{"seq":ack["seq"]})["message"]["data"]
        compose("kill","-s","KILL","nats")
        compose("up","-d","--force-recreate","--wait","nats")
        after=api("$JS.API.STREAM.MSG.GET."+stream,{"seq":ack["seq"]})["message"]["data"]
        assert before==after and json.loads(base64.b64decode(after))==pending
        example()
        pending_id=str(uuid.UUID(pending["id"]))
        database_name=demo["DATABASE_URL"].rsplit("/",1)[1]
        consumed=run(["docker","exec",container,"psql","-U","n2f","-d",database_name,"-Atc","SELECT count(*) FROM n2f_mailbox_receipts WHERE consumer='events-example' AND state='processed' AND event_id='"+pending_id+"'"]).stdout.strip()
        assert consumed=="1",consumed
        evidence["cases"].append("pending_envelope_survives_kill_recreate_and_consumes")
        compose("stop","-t","1","nats");example(False)
        compose("up","-d","--wait","nats");example()
        evidence["cases"].append("broker_outage_safe_refusal_and_reopen")
        evidence["redaction"]=True
        print(json.dumps(evidence,indent=2))
    finally:compose("down")
if __name__=="__main__":main()
