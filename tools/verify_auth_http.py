#!/usr/bin/env python3
"""Run this build's authentication process against an owned temporary PostgreSQL 18 service and exercise its HTTP surface."""
import base64, hashlib, http.client, json, os, pathlib, queue, re, signal, socket, subprocess, tempfile, threading, time, urllib.parse, urllib.request, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
LANG="go" if (ROOT/"go.mod").exists() else "rs" if (ROOT/"Cargo.toml").exists() else "nest"
TMP=pathlib.Path(os.environ.get("N2F_CHECK_TMP",tempfile.gettempdir()))
PROJECT="n2f-check-"+LANG
PG_PORT={"go":17921,"rs":17922,"nest":17923}[LANG]
HTTP_PORT={"go":17931,"rs":17932,"nest":17933}[LANG]
SMTP_PORT={"go":17941,"rs":17942,"nest":17943}[LANG]
MAILPIT_PORT={"go":17951,"rs":17952,"nest":17953}[LANG]
NODE24=os.path.expanduser("~/.nvm/versions/node/v24.19.0/bin")
ENV={**os.environ,"N2F_POSTGRES_PORT":str(PG_PORT),"N2F_SMTP_PORT":str(SMTP_PORT),"N2F_MAILPIT_UI_PORT":str(MAILPIT_PORT),"PATH":NODE24+os.pathsep+os.environ.get("PATH","")}
ORIGIN="http://127.0.0.1:%d"%HTTP_PORT
CSRF_KEY="verify-auth-http-key-0123456789abcdef0123456789abcdef"
PASSWORD_SENTINEL="correct horse battery SENTINEL"
NEW_PASSWORD="fresh passphrase SENTINEL after reset"
def run(args,env=None,timeout=600):
    r=subprocess.run(args,cwd=ROOT,env=env or ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    if r.returncode: raise RuntimeError("command failed: "+str(args)+"\n"+r.stdout[-8000:])
    return r.stdout
def compose(*args):return run(["docker","compose","-p",PROJECT,*args])
class Client:
    def __init__(self):self.cookies={}
    def call(self,method,path,body=None,origin=ORIGIN,csrf=None,cookies=True,raw=None):
        c=http.client.HTTPConnection("127.0.0.1",HTTP_PORT,timeout=5)
        headers={}
        if origin and method!="GET":headers["Origin"]=origin
        if csrf is not None:headers["X-CSRF-Token"]=csrf
        if cookies and self.cookies:headers["Cookie"]="; ".join(k+"="+v for k,v in self.cookies.items())
        data=None
        if raw is not None:data=raw;headers["Content-Type"]="application/json"
        elif body is not None:data=json.dumps(body);headers["Content-Type"]="application/json"
        c.request(method,path,body=data,headers=headers)
        r=c.getresponse();text=r.read().decode()
        for h,v in r.getheaders():
            if h.lower()=="set-cookie":
                name,_,rest=v.partition("=");value=rest.split(";",1)[0]
                if "max-age=0" in v.lower():self.cookies.pop(name,None)
                else:self.cookies[name]=value
        try:doc=json.loads(text) if text else None
        except ValueError:doc=text
        return r.status,dict((h.lower(),v) for h,v in r.getheaders()),doc
def mailpit(path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s"%(MAILPIT_PORT,path),timeout=5) as r:return json.load(r)
def mails(address):
    found=mailpit("/api/v1/search?query="+urllib.parse.quote("to:"+address))
    return [mailpit("/api/v1/message/"+m["ID"]) for m in found.get("messages") or []]
def wait_mails(address,count,seconds=10):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        got=mails(address)
        if len(got)>=count:return got
        time.sleep(.2)
    return mails(address)
def link_token(messages,path):
    for message in messages:
        m=re.search(re.escape(ORIGIN+path)+r"#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])",message.get("Text") or "")
        if m:return m.group(1)
    return None
def recv_exact(sock,n):
    out=b''
    while len(out)<n:
        part=sock.recv(n-len(out))
        if not part: raise AssertionError("socket closed")
        out+=part
    return out
def websocket_open(session_cookie,ticket):
    sock=socket.create_connection(("127.0.0.1",HTTP_PORT),timeout=5)
    key=base64.b64encode(os.urandom(16)).decode()
    request=("GET /_examples/socket HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n"%HTTP_PORT+
             "Upgrade: websocket\r\nConnection: Upgrade\r\nOrigin: "+ORIGIN+"\r\n"+
             "Cookie: "+session_cookie+"\r\nSec-WebSocket-Key: "+key+"\r\n"+
             "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: n2f.v1, n2f.ticket."+ticket+"\r\n\r\n")
    sock.sendall(request.encode()); response=b''
    while b"\r\n\r\n" not in response:
        part=sock.recv(4096)
        if not part: break
        response+=part
    head=response.split(b"\r\n\r\n",1)[0].decode("latin1"); status=int(head.splitlines()[0].split()[1])
    if status!=101: sock.close(); return status,None
    response_headers={line.split(":",1)[0].lower():line.split(":",1)[1].strip() for line in head.splitlines()[1:] if ":" in line}
    expected=base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    if response_headers.get("sec-websocket-accept")!=expected or response_headers.get("sec-websocket-protocol")!="n2f.v1": sock.close(); raise AssertionError("invalid websocket handshake")
    return status,sock
def websocket_ping(sock):
    payload=json.dumps({"v":1,"id":"verify","type":"ping","payload":{}}).encode(); mask=os.urandom(4)
    frame=bytearray([0x81,0x80|len(payload)])+bytearray(mask); frame.extend(bytes(b^mask[i%4] for i,b in enumerate(payload))); sock.sendall(frame)
    try:
        while True:
            first=recv_exact(sock,2); opcode=first[0]&15; length=first[1]&127
            if length==126: length=int.from_bytes(recv_exact(sock,2),"big")
            elif length==127: length=int.from_bytes(recv_exact(sock,8),"big")
            body=recv_exact(sock,length)
            if opcode==1: return json.loads(body.decode())
            if opcode==8: return None
            if opcode==9:
                m=os.urandom(4); reply=bytearray([0x8a,0x80|len(body)])+bytearray(m); reply.extend(bytes(b^m[i%4] for i,b in enumerate(body))); sock.sendall(reply)
    except (AssertionError,OSError,socket.timeout): return None
def websocket_request(session_cookie,ticket):
    status,sock=websocket_open(session_cookie,ticket)
    if not sock:return status,None
    try:return status,websocket_ping(sock)
    finally:sock.close()
def main():
    process=None;evidence={"language":LANG,"steps":[]};seen=[]
    def step(name,ok):
        assert ok,name;evidence["steps"].append(name)
    try:
        compose("up","-d","--wait","postgres","mailpit")
        container=compose("ps","-q","postgres").strip()
        name="auth_"+uuid.uuid4().hex[:12]
        run(["docker","exec",container,"psql","-U","n2f","-d","n2f","-c","CREATE DATABASE "+name])
        database="postgres://n2f:n2f_local@127.0.0.1:%d/%s"%(PG_PORT,name)
        env={**ENV,"DEMO_TOKEN":"fixture-SENTINEL","AUTH_ENABLED":"true","DATABASE_ENABLED":"true","DATABASE_URL":database,"DATABASE_TIMEOUT_MS":"1000","AUTH_DEV_INSECURE_COOKIES":"true","AUTH_COOKIE_SECURE":"false","AUTH_ALLOWED_ORIGINS":ORIGIN,"AUTH_CSRF_KEY":CSRF_KEY,"AUTH_BLOCKLIST_PATH":"config/password-blocklist.txt","AUTH_SMTP_HOST":"127.0.0.1","AUTH_SMTP_PORT":str(SMTP_PORT),"AUTH_SMTP_SECURITY":"none","AUTH_MAIL_FROM":"no-reply@n2f.local","AUTH_LINK_ORIGIN":ORIGIN,"WS_ORIGIN":ORIGIN,"HTTP_PORT":str(HTTP_PORT),"HTTP_TIMEOUT_MS":"5000","LOG_FORMAT":"json","TELEMETRY_MODE":"none","SHUTDOWN_MS":"3000"}
        if LANG=="go":
            env["GOCACHE"]=str(TMP/"n2f-http-go-cache");binary=TMP/"n2f-auth-go"
            run(["go","build","-o",str(binary),"./cmd/http-example"],env);command=[str(binary)]
        elif LANG=="rs":
            target=os.environ.get("CARGO_TARGET_DIR",str(TMP/"n2f-http-rs"))
            run(["cargo","build","--offline","--locked","--target-dir",target,"--bin","http-example"],env);command=[str(pathlib.Path(target)/"debug/http-example")]
        else:
            run(["pnpm","run","build"],env);command=["node","dist/http-example.js"]
        process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        out=[];err=[]
        threading.Thread(target=lambda:[out.append(l) for l in process.stdout],daemon=True).start()
        threading.Thread(target=lambda:[err.append(l) for l in process.stderr],daemon=True).start()
        end=time.monotonic()+20
        while time.monotonic()<end and not any("http.listening" in l for l in err+out):
            if process.poll() is not None:raise AssertionError("process exited before listening:\n"+"".join(err[-40:])+"\n"+"".join(out[-40:]))
            time.sleep(.1)
        assert any("http.listening" in l for l in err+out),"no listener"
        manifest="".join(out+err)
        step("manifest_names_auth_settings","AUTH_ALLOWED_ORIGINS" in manifest and "AUTH_CSRF_KEY" in manifest and CSRF_KEY not in manifest and "auth.mail" in manifest and "smtp" in manifest)
        c=Client()
        s,h,d=c.call("GET","/v1/auth/csrf");step("csrf_issued",s==200 and isinstance(d,dict) and d.get("csrf_token") and any(k.endswith("csrf") for k in c.cookies) and h.get("cache-control")=="no-store")
        token=d["csrf_token"];email="ada.%s@example.com"%uuid.uuid4().hex[:8]
        s,h,d=c.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD_SENTINEL},origin=None,csrf=token);step("post_without_origin_403",s==403 and d.get("code")=="identity.origin_rejected")
        s,h,d=c.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD_SENTINEL},csrf=token[:-2]+"AA");step("csrf_mismatch_403",s==403 and d.get("code")=="identity.csrf_rejected")
        s,h,d=c.call("POST","/v1/auth/register",raw='{"email": "x@example.com", "password": "p", "extra": 1}',csrf=token);step("unknown_member_400",s==400)
        s,h,d=c.call("POST","/v1/auth/register",{"email":email,"password":"password123456789"},csrf=token);step("blocklisted_400",s==400 and d.get("code")=="identity.password_invalid")
        s,h,d=c.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD_SENTINEL},csrf=token);step("register_202",s==202 and d=={"accepted":True})
        s,h,d=c.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD_SENTINEL},csrf=token);step("duplicate_202",s==202 and d=={"accepted":True})
        s1,h1,d1=c.call("POST","/v1/auth/login",{"email":email,"password":PASSWORD_SENTINEL+"!"},csrf=token)
        s2,h2,d2=c.call("POST","/v1/auth/login",{"email":email,"password":PASSWORD_SENTINEL},csrf=token)
        strip=lambda x:{k:v for k,v in x.items() if k not in ("request_id","correlation_id")}
        step("login_refusals_identical",s1==401 and s2==401 and strip(d1)==strip(d2) and d1.get("code")=="identity.credentials_rejected")
        anon=Client();s,h,d=anon.call("GET","/v1/auth/session");step("session_without_cookie_401",s==401 and d.get("code")=="identity.session_rejected")
        s,h,d=c.call("POST","/v1/auth/logout",csrf=token);step("logout_without_session_204",s==204 and not any(k.endswith("session") for k in c.cookies))
        s,h,d=c.call("GET","/v1/auth/csrf");token=d["csrf_token"]
        last=None
        for i in range(4):last=c.call("POST","/v1/auth/register",{"email":email,"password":PASSWORD_SENTINEL},csrf=token)
        step("rate_limited_429",last[0]==429 and last[1].get("retry-after") and last[2].get("code")=="identity.auth_rate_limited")
        got=wait_mails(email,1);vt=link_token(got,"/verify-email");seen.append(vt)
        step("verification_mail_once",len(got)==1 and vt is not None and "token" not in (got[0].get("Subject") or ""))
        s,h,d=c.call("GET","/v1/auth/csrf");token=d["csrf_token"]
        s,h,d=c.call("POST","/v1/auth/email/verify",{"token":vt,"password":PASSWORD_SENTINEL+"!"},csrf=token);step("verify_requires_password_401",s==401 and d.get("code")=="identity.challenge_rejected")
        s,h,d=c.call("POST","/v1/auth/email/verify",{"token":vt,"password":PASSWORD_SENTINEL},csrf=token);step("verify_204",s==204)
        s,h,d=c.call("POST","/v1/auth/email/verify",{"token":vt,"password":PASSWORD_SENTINEL},csrf=token);step("verify_replay_401",s==401 and d.get("code")=="identity.challenge_rejected")
        s,h,d=c.call("POST","/v1/auth/login",{"email":email,"password":PASSWORD_SENTINEL},csrf=token)
        session_name=next((k for k in c.cookies if k.endswith("session")),None)
        step("login_200",s==200 and isinstance(d,dict) and bool(d.get("principal_id")) and bool(d.get("csrf_token")) and session_name is not None and c.cookies[session_name] not in json.dumps(d) and h.get("cache-control")=="no-store")
        principal=d["principal_id"];token=d["csrf_token"];seen.append(c.cookies[session_name])
        s,h,d=c.call("GET","/v1/auth/session");step("session_200",s==200 and d.get("principal_id")==principal)
        s,h,d=c.call("POST","/v1/org/organizations",{"name":"Launch Team 🌱"},csrf=token)
        created=d if isinstance(d,dict) else {};organization=created.get("organization") or {};owner=created.get("owner") or {}
        step("org_create_201",s==201 and isinstance(organization,dict) and bool(organization.get("id")) and organization.get("name")=="Launch Team 🌱" and isinstance(owner,dict) and bool(owner.get("id")) and owner.get("organization_id")==organization.get("id") and owner.get("principal_id")==principal and owner.get("role")=="owner" and h.get("cache-control")=="no-store")
        s,h,d=c.call("GET","/v1/org/organizations");listed=d if isinstance(d,dict) else {};items=listed.get("organizations") or {};item=items[0] if isinstance(items,list) and items else {};listed_org=item.get("organization") or {};listed_membership=item.get("membership") or {}
        step("org_list_200",s==200 and listed.get("limit")==50 and len(items)==1 and listed_org.get("id")==organization.get("id") and listed_membership.get("principal_id")==principal and listed_membership.get("role")=="owner" and h.get("cache-control")=="no-store")
        s,h,d=c.call("GET","/v1/org/organizations?limit=0");step("org_list_invalid_query_400",s==400 and d.get("code")=="org.invalid_query")
        invitee=Client();s,h,d=invitee.call("GET","/v1/auth/csrf");invitee_csrf=d["csrf_token"]
        invitee_email="grace.%s@example.com"%uuid.uuid4().hex[:8]
        s,h,d=invitee.call("POST","/v1/auth/register",{"email":invitee_email,"password":PASSWORD_SENTINEL},csrf=invitee_csrf);step("invitee_register_202",s==202 and d=={"accepted":True})
        invitee_mail=wait_mails(invitee_email,1);invitee_verify=link_token(invitee_mail,"/verify-email");seen.append(invitee_verify)
        s,h,d=invitee.call("POST","/v1/auth/email/verify",{"token":invitee_verify,"password":PASSWORD_SENTINEL},csrf=invitee_csrf);step("invitee_verify_204",s==204)
        s,h,d=invitee.call("GET","/v1/auth/csrf");invitee_csrf=d["csrf_token"]
        s,h,d=invitee.call("POST","/v1/auth/login",{"email":invitee_email,"password":PASSWORD_SENTINEL},csrf=invitee_csrf)
        invitee_principal=d.get("principal_id") if isinstance(d,dict) else None;invitee_csrf=d.get("csrf_token") if isinstance(d,dict) else None;invitee_session_name=next((k for k in invitee.cookies if k.endswith("session")),None)
        step("invitee_login_200",s==200 and invitee_principal and invitee_csrf and invitee_session_name)
        s,h,d=c.call("POST","/v1/org/invitations",{"organization_id":organization.get("id"),"principal_id":invitee_principal,"role":"member"},csrf=token)
        invitation=(d.get("invitation") if isinstance(d,dict) else {}) or {};invitation_id=invitation.get("id")
        step("org_invite_201",s==201 and invitation.get("organization_id")==organization.get("id") and invitation.get("inviter_principal_id")==principal and invitation.get("invitee_principal_id")==invitee_principal and invitation.get("role")=="member" and invitation.get("status")=="pending" and invitation_id and h.get("cache-control")=="no-store")
        s,h,d=c.call("POST","/v1/org/invitations",{"organization_id":organization.get("id"),"principal_id":invitee_principal,"role":"member"},csrf=token);step("org_invite_duplicate_409",s==409 and d.get("code")=="org.invitation_exists")
        s,h,d=invitee.call("POST","/v1/org/invitations/accept",{"invitation_id":invitation_id},csrf=invitee_csrf)
        accepted=(d.get("invitation") if isinstance(d,dict) else {}) or {};accepted_membership=(d.get("membership") if isinstance(d,dict) else {}) or {}
        step("org_invitation_accept_200",s==200 and accepted.get("status")=="accepted" and accepted_membership.get("principal_id")==invitee_principal and accepted_membership.get("role")=="member" and h.get("cache-control")=="no-store")
        s,h,d=invitee.call("POST","/v1/org/invitations/accept",{"invitation_id":invitation_id},csrf=invitee_csrf);step("org_invitation_replay_409",s==409 and d.get("code")=="org.invitation_already_accepted")
        s,h,d=invitee.call("GET","/v1/org/organizations");invitee_items=(d.get("organizations") if isinstance(d,dict) else []) or [];invitee_membership=((invitee_items[0] if invitee_items else {}).get("membership") or {})
        step("invitee_org_list_200",s==200 and len(invitee_items)==1 and invitee_membership.get("principal_id")==invitee_principal and invitee_membership.get("role")=="member")
        s,h,d=c.call("POST","/v1/org/memberships/role",{"organization_id":organization.get("id"),"principal_id":invitee_principal,"role":"admin"},csrf=token)
        changed=(d.get("membership") if isinstance(d,dict) else {}) or {};step("org_role_change_200",s==200 and changed.get("principal_id")==invitee_principal and changed.get("role")=="admin" and h.get("cache-control")=="no-store")
        s,h,d=invitee.call("GET","/v1/org/organizations");invitee_items=(d.get("organizations") if isinstance(d,dict) else []) or [];invitee_membership=((invitee_items[0] if invitee_items else {}).get("membership") or {})
        step("org_role_reflected_200",s==200 and len(invitee_items)==1 and invitee_membership.get("role")=="admin")
        s,h,d=invitee.call("POST","/v1/org/invitations",{"organization_id":organization.get("id"),"principal_id":principal,"role":"admin"},csrf=invitee_csrf);step("org_admin_cannot_invite_admin_403",s==403 and d.get("code")=="org.membership_forbidden")
        s,h,d=invitee.call("POST","/v1/org/memberships/role",{"organization_id":organization.get("id"),"principal_id":principal,"role":"member"},csrf=invitee_csrf);step("org_owner_role_protected_400",s==400 and d.get("code")=="org.role_transition_invalid")
        s,h,d=c.call("POST","/v1/org/organizations",raw='{"name":"Launch","name":"Again"}',csrf=token);step("org_duplicate_json_400",s==400 and d.get("code")=="http.invalid_body")
        s,h,d=c.call("POST","/v1/org/organizations",raw=json.dumps({"name":"Injected owner","owner_principal_id":principal}),csrf=token);step("org_owner_input_rejected",s==400 and d.get("code")=="http.invalid_body")
        s,h,d=c.call("POST","/v1/org/organizations",{"name":"Missing origin"},origin=None,csrf=token);step("org_origin_403",s==403 and d.get("code")=="identity.origin_rejected")
        s,h,d=c.call("POST","/v1/org/organizations",{"name":"Bad csrf"},csrf=token[:-2]+"AA");step("org_csrf_403",s==403 and d.get("code")=="identity.csrf_rejected")
        stranger_client=Client();s,h,d=stranger_client.call("POST","/v1/org/organizations",{"name":"No session"});step("org_requires_session_401",s==401 and d.get("code")=="identity.session_rejected")
        s,h,d=stranger_client.call("GET","/v1/org/organizations");step("org_list_requires_session_401",s==401 and d.get("code")=="identity.session_rejected")
        s,h,d=c.call("POST","/v1/auth/websocket-ticket",csrf=token)
        ws_ticket=d.get("ticket") if isinstance(d,dict) else None
        if ws_ticket: seen.append(ws_ticket)
        step("websocket_ticket_200",s==200 and isinstance(ws_ticket,str) and len(ws_ticket)==43 and d.get("expires_at_ms",0)>0)
        if ws_ticket:
            session_cookie=session_name+"="+c.cookies[session_name]
            ws_status,ws_body=websocket_request(session_cookie,ws_ticket)
            step("websocket_upgrade_101",ws_status==101 and isinstance(ws_body,dict) and ws_body.get("type")=="pong")
            replay_status,_=websocket_request(session_cookie,ws_ticket)
            step("websocket_ticket_single_use",replay_status==401)
        s,h,d=c.call("POST","/v1/auth/websocket-ticket",csrf=token)
        live_ticket=d.get("ticket") if isinstance(d,dict) else None
        if live_ticket: seen.append(live_ticket)
        live_status,live_sock=websocket_open(session_cookie,live_ticket) if live_ticket else (0,None)
        live_body=websocket_ping(live_sock) if live_sock else None
        step("websocket_revalidation_initial_ping",live_status==101 and isinstance(live_body,dict) and live_body.get("type")=="pong")
        s,h,d=c.call("POST","/v1/auth/logout",csrf=token);step("logout_204_clears_session",s==204 and not any(k.endswith("session") for k in c.cookies))
        revoked_body=websocket_ping(live_sock) if live_sock else None
        step("websocket_revalidation_after_logout",live_sock is not None and revoked_body is None)
        if live_sock:live_sock.close()
        s,h,d=c.call("GET","/v1/auth/session");step("session_after_logout_401",s==401)
        s,h,d=c.call("GET","/v1/auth/csrf");token=d["csrf_token"]
        stranger="nobody.%s@example.com"%uuid.uuid4().hex[:8]
        s,h,d=c.call("POST","/v1/auth/password/reset-requests",{"email":email},csrf=token);step("reset_request_202",s==202 and d=={"accepted":True})
        s,h,d=c.call("POST","/v1/auth/password/reset-requests",{"email":stranger},csrf=token);step("unknown_reset_request_202",s==202 and d=={"accepted":True})
        got=wait_mails(email,2);rt=link_token(got,"/reset-password");seen.append(rt)
        step("reset_mail_link",rt is not None and rt!=vt)
        step("unknown_reset_no_mail",mails(stranger)==[])
        s,h,d=c.call("POST","/v1/auth/password/reset",{"token":rt,"password":NEW_PASSWORD},csrf=token);step("reset_204",s==204)
        s1,_,_=c.call("POST","/v1/auth/login",{"email":email,"password":PASSWORD_SENTINEL},csrf=token)
        s2,_,_=c.call("POST","/v1/auth/login",{"email":email,"password":NEW_PASSWORD},csrf=token)
        step("login_after_reset",s1==401 and s2==200)
        evidence["mails"]=len(mails(email))
        def facts(kind):return run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM public.n2f_outbox WHERE envelope::jsonb->>'type'='%s'"%kind]).strip()
        counts={k:facts(k) for k in ["identity.principal.registered.v1","identity.email.verified.v1","identity.session.created.v1","identity.session.revoked.v1","identity.password.changed.v1","identity.sessions.revoked.v1"]}
        evidence["outbox"]=counts
        step("outbox_facts",counts=={"identity.principal.registered.v1":"2","identity.email.verified.v1":"2","identity.session.created.v1":"3","identity.session.revoked.v1":"1","identity.password.changed.v1":"1","identity.sessions.revoked.v1":"1"})
        org_counts={
            "organizations":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM public.n2f_org_organizations"]).strip(),
            "memberships":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT count(*) FROM public.n2f_org_memberships"]).strip(),
            "owner_principal":run(["docker","exec",container,"psql","-U","n2f","-d",name,"-tAc","SELECT principal_id::text FROM public.n2f_org_memberships LIMIT 1"]).strip(),
        }
        evidence["org"]=org_counts
        step("org_rows",org_counts=={"organizations":"1","memberships":"2","owner_principal":principal})
        s,h,d=anon.call("GET","/readyz");step("ready",s==200)
        started=time.monotonic();process.send_signal(signal.SIGTERM);process.wait(timeout=5);evidence["shutdown_ms"]=round((time.monotonic()-started)*1000)
        step("exit_zero",process.returncode==0)
        text="".join(out+err)
        step("redaction","SENTINEL" not in text and email not in text and CSRF_KEY not in text and database not in text and all(t and t not in text for t in seen))
        completed=[json.loads(l) for l in text.splitlines() if l.startswith("{") and '"http.request.completed"' in l]
        route=lambda r:r.get("route") or (r.get("fields") or {}).get("route")  # flat (slog) or nested (fields) records
        step("completion_logs",len([r for r in completed if route(r)=="/v1/auth/register"])>=7 and len([r for r in completed if route(r)=="/v1/org/organizations"])>=3 and len([r for r in completed if route(r)=="/v1/org/invitations"])>=2 and len([r for r in completed if route(r)=="/v1/org/invitations/accept"])>=2 and len([r for r in completed if route(r)=="/v1/org/memberships/role"])>=1 and not any("Cookie" in json.dumps(r) for r in completed))
        print(json.dumps(evidence,indent=2))
    finally:
        if process and process.poll() is None:process.kill();process.wait()
        compose("down")
if __name__=="__main__":main()
