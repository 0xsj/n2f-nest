# Organization domain leaves

The org domain contains `Organization`, `Membership` and `Invitation` validated
values with owned snapshots. The contract is mirrored at
`src/modules/org/domain/CONTRACT.md` and uses O01–O10.

The useful boundary discovered here is the separation between an organization
value and the workflow that creates it. An owner membership is a separate value,
even though the application operation will create it with the organization. The
owner constructor makes the role explicit; it does not make a principal
eligible, authenticated, active, or authorized. A principal ID is only a
reference.

`CreateOrganization` uses an org-owned principal-eligibility capability. Root
translates identity's deliberate application surface into that capability
without importing identity internals into the org domain. Invitation acceptance
and role changes keep their local state transitions in the store transaction;
the domain only validates the invitation lifecycle and snapshots.

Names preserve caller spelling and use Unicode-scalar bounds. The domain rejects
ASCII whitespace-only names and C0/DEL controls, but does not trim, normalize,
case-fold, or decide slug uniqueness. Returned snapshots are copied and frozen
internally so later callers cannot mutate domain state.

Verified in this slice: the org specs, full Vitest suite and the live
root-composed organization membership HTTP flow. The domain does not authenticate
principals or decide membership authorization; suspension, ownership transfer,
removal and retention remain separate policy slices.
