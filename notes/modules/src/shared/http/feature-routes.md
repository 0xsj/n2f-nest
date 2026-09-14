# Feature routes: open the scope after admission, keep the template on 405

**Origin:** implementing H15–H19 on the Nest adapter on 2026-09-12, spec-first
against a real ephemeral server.

The scope used to open in the middleware, before any route work. Attribution is
fixed at `enter`, so an admission that establishes a user actor has to run
first; the scope now opens in `handle` after routing, the body read and
admission, and the middleware only starts observation and records the matched
template. A refused admission still opens a scope (operation `http.admission`,
anonymous attribution) so the problem carries request and correlation IDs and
the completion log is bound. The mutation that opens the scope with anonymous
attribution regardless of admission is caught by the overlapping-request test,
which is the same observable as "admission after open".

Routing is a map of template → method → route. A template matched with an
unregistered method is 405 with Allow computed from that map (HEAD added for
GET), and the observation records the template even though no route ran; the
first draft dropped it because it read the template off the route.

Cookie parsing keeps duplicates as lists and skips malformed pairs instead of
refusing the whole header; the route owner decides that two session cookies are
a refusal. Node joins repeated Cookie headers with `; ` before the adapter sees
them, so a repeated header and a repeated pair look the same here.

Express omits the body for HEAD on its own, so HEAD-for-GET is a routing rule,
not a write rule. `Reply.create` validates the allowlist at construction so an
unlisted header never reaches `res.setHeader`; the adapter treats the resulting
failure as a handler error, and the 500 is observed as `failed`.

`Uint8Array` typing under `strict` distinguishes `ArrayBuffer` from
`ArrayBufferLike`; the body variable needs the wider annotation or `Buffer.concat`
does not assign.

**Limits:** the trusted source key is the peer address by default; the
forwarding policy is root's to supply. No feature route, cookie policy or CSRF
rule lives here. `tools/verify_http.py` passed unchanged after the extension
(48 requests, 48 completion logs), which covers the diagnostic routes only.

**Used in:** feature.ts, nest/server.ts, feature.spec.ts and nest/feature.spec.ts.
See [request ownership](nest/request-ownership.md).
