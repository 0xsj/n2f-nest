#!/usr/bin/env python3
"""Run the org workflow with real curl requests against a running build.

This intentionally shells out to curl so the same request path is easy to
inspect, copy and reproduce from a terminal or an .http client.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_PORT = 7100 if (ROOT / "go.mod").exists() else 7200 if (ROOT / "Cargo.toml").exists() else 7300


def request(base, method, path, cookie=None, csrf=None, origin=None, body=None):
    args = ["curl", "--silent", "--show-error", "--request", method, base.rstrip("/") + path]
    if origin and method != "GET":
        args += ["--header", "Origin: " + origin]
    if csrf:
        args += ["--header", "X-CSRF-Token: " + csrf]
    if cookie:
        args += ["--cookie", cookie]
    if body is not None:
        args += ["--header", "Content-Type: application/json", "--data-binary", json.dumps(body)]
    args += ["--write-out", "\n%{http_code}"]
    result = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
    raw, _, code = result.stdout.rpartition("\n")
    try:
        document = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        document = raw
    return int(code or 0), document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=f"http://127.0.0.1:{DEFAULT_PORT}")
    parser.add_argument("--origin")
    parser.add_argument("--owner-cookie", default=os.getenv("N2F_OWNER_COOKIE"))
    parser.add_argument("--owner-csrf", default=os.getenv("N2F_OWNER_CSRF"))
    parser.add_argument("--invitee-cookie", default=os.getenv("N2F_INVITEE_COOKIE"))
    parser.add_argument("--invitee-csrf", default=os.getenv("N2F_INVITEE_CSRF"))
    parser.add_argument("--organization-id", default=os.getenv("N2F_ORGANIZATION_ID"))
    parser.add_argument("--invitee-principal-id", default=os.getenv("N2F_INVITEE_PRINCIPAL_ID"))
    args = parser.parse_args()
    origin = args.origin or args.base_url
    if not args.owner_cookie:
        parser.error("--owner-cookie or N2F_OWNER_COOKIE is required")
    steps = []

    def step(name, expected, actual, document):
        ok = actual == expected
        steps.append((name, ok, actual, document))
        if not ok:
            print(json.dumps({"step": name, "expected": expected, "status": actual, "body": document}, indent=2), file=sys.stderr)
        return ok

    status, document = request(args.base_url, "GET", "/v1/org/organizations", cookie=args.owner_cookie)
    step("owner_list", 200, status, document)
    if args.organization_id or args.invitee_principal_id or args.owner_csrf:
        if not args.owner_csrf or not args.organization_id or not args.invitee_principal_id:
            parser.error("mutations require --owner-csrf, --organization-id and --invitee-principal-id")
        status, document = request(args.base_url, "POST", "/v1/org/invitations", cookie=args.owner_cookie, csrf=args.owner_csrf, origin=origin, body={"organization_id": args.organization_id, "principal_id": args.invitee_principal_id, "role": "member"})
        if not step("owner_invite", 201, status, document):
            return 1
        invitation = (document.get("invitation") if isinstance(document, dict) else {}) or {}
        invitation_id = invitation.get("id")
        if not invitation_id:
            print("invite response did not contain invitation.id", file=sys.stderr)
            return 1
        if args.invitee_cookie and args.invitee_csrf:
            status, document = request(args.base_url, "POST", "/v1/org/invitations/accept", cookie=args.invitee_cookie, csrf=args.invitee_csrf, origin=origin, body={"invitation_id": invitation_id})
            if not step("invitee_accept", 200, status, document):
                return 1
            status, document = request(args.base_url, "POST", "/v1/org/memberships/role", cookie=args.owner_cookie, csrf=args.owner_csrf, origin=origin, body={"organization_id": args.organization_id, "principal_id": args.invitee_principal_id, "role": "admin"})
            if not step("owner_promote", 200, status, document):
                return 1
            status, document = request(args.base_url, "GET", "/v1/org/organizations", cookie=args.invitee_cookie)
            step("invitee_list_after_promotion", 200, status, document)
    failed = sum(not ok for _, ok, _, _ in steps)
    print(json.dumps({"steps": len(steps), "failed": failed, "result": "passed" if failed == 0 else "failed"}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
