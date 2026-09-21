# Implementation Blueprint Protocol

> A repeatable method for describing how a complete domain or service should be constructed, file by file and symbol by symbol, without producing the implementation.

**Status:** Draft

**Purpose:** After architecture, boundaries, and behavior have been established, produce a guided first-pass construction specification that a developer or agent can follow.

**Primary output:** A Markdown implementation blueprint for one exemplary domain, service, or vertical slice.

**Core rule:** The blueprint describes what each file and symbol must do. It does not implement them.

---

## 1. When to use this protocol

Use this protocol when:

- The architecture and ownership boundaries are sufficiently established.
- A representative domain or service has been selected as an exemplar.
- The first implementation should expose missing decisions before broad implementation begins.
- A developer or agent needs a guided construction order.
- The implementation should be comparable across languages, frameworks, or surfaces.

Do not use it as a substitute for product discovery, architecture decisions, or behavioral contracts. It consumes those materials and translates them into a construction plan.

The protocol is especially useful for a first complete slice that exercises several boundaries, such as identity, billing, ingestion, investigation, or a live operational workflow.

---

## 2. What this is and is not

### This is

- A complete expected file tree for the selected slice.
- A description of the responsibility and ownership of every required file.
- A description of public and important internal symbols.
- A record of inputs, outputs, preconditions, postconditions, refusals, and side-effect ordering.
- A construction order that lets a person work through the slice incrementally.
- A verification plan tied to the described behavior.
- A place to expose missing decisions before implementation hides them.

### This is not

- Source code.
- A generated scaffold.
- A replacement for `ARCHITECTURE.md`.
- A replacement for a domain or application contract.
- A generic list of packages to create in every project.
- Permission to invent unspecified behavior.
- A guarantee that the implementation will require no judgment.

Signatures, type shapes, tables, state diagrams, and prose are allowed. Function bodies, production pseudocode, framework boilerplate, and implementation snippets are not part of the blueprint.

---

## 3. Relationship to surrounding documents

The expected source hierarchy is:

1. Product direction and scope
2. Architecture and ownership
3. Decisions and boundaries
4. Domain/application contracts
5. Implementation blueprint
6. Implementation and executable verification
7. Notes recording what was learned

The blueprint must link to the documents it consumes. It must not silently override them.

If the blueprint discovers a contradiction, it records the contradiction and points to the decision or contract that must be resolved. It does not choose a new behavior merely to make the file tree look complete.

The protocol itself is a reusable procedure. A blueprint is the domain-specific document produced by applying the procedure.

Suggested locations:

```text
protocols/implementation-blueprint.md
<domain-or-service>/BUILD-SPEC.md
```

The protocol can travel between projects. The blueprint belongs beside the domain or service it describes.

---

## 4. Required inputs

Before writing the blueprint, identify the available inputs and their status.

| Input | Required question |
| --- | --- |
| Scope | What user or system outcome does this slice cover? |
| Architecture | Which layers, modules, and dependency directions apply? |
| Decisions | Which choices are settled, conditional, or still open? |
| Domain contract | What values, invariants, transitions, and refusals exist? |
| Application contract | What commands, queries, ports, outcomes, and side effects exist? |
| Transport contract | How are external inputs admitted and outputs projected? |
| Persistence contract | What is stored, loaded, committed, versioned, or made idempotent? |
| Verification contract | Which scenarios, properties, fixtures, or mutations must be checked? |
| Exemplar | Which complete workflow will expose the architecture's gaps? |

Each input is marked as one of:

- **Established:** can be relied upon.
- **Proposed:** useful working direction, not yet decided.
- **Unknown:** requires a decision, research, or experiment.
- **Not applicable:** deliberately outside this slice.

---

## 5. Blueprint construction procedure

### Step 1 — State the exemplar

Describe the one domain or service being specified.

Include:

- The user or system actor.
- The primary outcome.
- The complete first workflow.
- What is deliberately outside scope.
- Why this slice is a useful architectural exemplar.

The exemplar must be concrete enough that two people can describe the same first-pass behavior.

### Step 2 — Establish the source of truth

List the architecture, decisions, contracts, and existing conventions used by the blueprint. Identify any disagreement before describing files.

### Step 3 — Define the nouns and lifecycle

List the domain records, values, actors, commands, queries, events, external dependencies, and lifecycle states used by the slice.

For each important record, describe:

- Identity.
- Owner.
- Required fields.
- Invariants.
- State transitions.
- Whether it is mutable, append-only, immutable, versioned, or archived.
- Which layer is allowed to create or change it.

### Step 4 — Describe the complete workflow

Describe the normal path and meaningful refusal paths in order.

Include:

- Admission and validation.
- Dependency calls.
- Domain decisions.
- Persistence boundaries.
- Event or notification consequences.
- Commit and uncertainty behavior.
- Response projection.

The workflow description must make side-effect ordering explicit.

### Step 5 — Enumerate the expected tree

List every file required for the exemplar, including tests, migrations, fixtures, adapters, configuration, and documentation when they are part of the agreed first pass.

Each file receives one status:

- **Required:** must exist for the specified slice.
- **Optional:** useful but not needed for the first pass.
- **Deferred:** intentionally postponed and explains why.
- **Forbidden:** must not be created because ownership belongs elsewhere or the behavior is out of scope.

Do not create empty directories merely because the architecture contains a possible layer.

### Step 6 — Specify every required file

Use the file contract below for each required file. Repeat the same discipline for optional files that are included in the first pass.

### Step 7 — Specify symbols and interactions

Describe public symbols and important internal symbols. A symbol description must be sufficient for an implementer to know what it accepts, returns, owns, refuses, and delegates.

### Step 8 — Define verification

For every behavior that matters, name the scenario, oracle, fixture, or integration check that will establish it. Include refusal behavior and failure ordering, not only successful examples.

### Step 9 — Produce the construction order

Order the files by behavior and dependency, not by alphabet or visual convenience. Each step should leave a useful, verifiable increment.

### Step 10 — Run a completeness audit

Check that every named symbol has an owner, every dependency has a provider, every side effect has an ordering rule, every refusal has a projection, and every required behavior has verification.

---

## 6. Required blueprint structure

Every blueprint should contain these sections unless a section is explicitly marked not applicable:

```markdown
# <Domain or service> construction specification

## Status and scope
## Exemplar workflow
## Source documents and authority
## Nouns, states, and invariants
## Workflow and side-effect ordering
## Expected file tree
## File specifications
## Cross-file dependency map
## Transport and persistence mapping
## Verification plan
## Construction order
## Open decisions and unknowns
## Deviation record
## Completion criteria
```

The blueprint may link to detailed contracts rather than copying them, but it must state which contract section controls each important behavior.

---

## 7. File specification template

Each required file should use this shape.

```markdown
## `<path/to/file>`

**Status:** Required | Optional | Deferred | Forbidden

### Role

What this file exists to own.

### Layer and ownership

Which layer or module owns it, and which boundary it protects.

### Owns

- Responsibilities and state this file may define or change.

### Does not own

- Responsibilities that must remain in another file or layer.

### Dependencies

- Allowed imports, ports, values, configuration, or collaborators.
- Dependencies that are explicitly forbidden.

### Symbols

List the public and important internal symbols described below.

### Side effects and ordering

What can change outside the file and what must happen before or after it.

### Failure and refusal behavior

Expected domain refusals, dependency failures, uncertain outcomes, and recovery meaning.

### Verification

Named tests, scenarios, fixtures, or integration checks.

### Traceability

Links to the contract, decision, invariant, or workflow step that requires this file.
```

The file entry should make it possible to reject an implementation that is in the correct directory but owns the wrong behavior.

---

## 8. Symbol specification template

Use this shape for functions, methods, constructors, handlers, queries, commands, ports, and important types.

```markdown
### `<SymbolName>`

**Kind:** function | method | constructor | type | port | handler | query | command

**Purpose:** One sentence describing the responsibility.

**Input:** Named fields, validated values, caller context, and relevant identity or version information.

**Output:** Success value, private result details, and classified failure shape.

**Preconditions:** What must already be true or validated.

**Behavior:** Ordered prose describing what the symbol does.

**Refusals:** Domain-level expected negative outcomes.

**Dependency failures:** Which failures pass through, are wrapped, or become unavailable.

**Postconditions:** What is guaranteed after each meaningful outcome.

**Side effects:** Writes, events, messages, external calls, or observable state changes.

**Idempotency and concurrency:** Duplicate behavior, expected-version rules, locking, or explicit absence of guarantees.

**Verification:** Scenarios and selected faults that must be detected.
```

A function such as `SignIn` must not be described only as “authenticates a user.” The blueprint must state what it receives, what it calls, what it refuses, what it reveals, what it writes, and what remains uncertain when a dependency fails.

---

## 9. Construction order

The blueprint should normally guide a first pass in this order:

1. Read the source documents and confirm unresolved decisions.
2. Establish shared value and error contracts.
3. Define domain values, invariants, and pure transitions.
4. Define application commands, queries, outcomes, and consumer-owned ports.
5. Define in-memory fakes or fixtures that can exercise the application behavior.
6. Define concrete persistence and external adapters behind the stated ports.
7. Define transport admission and response projection.
8. Compose dependencies at the root or composition boundary.
9. Add integration verification for the concrete adapters.
10. Compare the implementation against the blueprint and record deviations.

This is a default order, not a requirement to create every layer. A read-only slice may not need commands; a pure domain slice may not need transport; an adapter may not be justified until the behavior behind its port is established.

---

## 10. Agent operating rules

When an agent is asked to implement from a blueprint:

1. Read the blueprint and its linked authority documents first.
2. Report missing or contradictory specifications before making a material choice.
3. Work in the stated construction order unless the user approves a change.
4. Do not create an unlisted file, symbol, dependency, or abstraction without recording the reason.
5. Do not substitute a framework convention for an explicit contract.
6. Preserve refusal meanings and side-effect ordering.
7. Keep implementation details inside the ownership boundary named by the blueprint.
8. Run the verification named for the current increment.
9. After each significant increment, report what was implemented, what remains, and any deviation.
10. At completion, produce a deviation report rather than claiming exact conformance automatically.

The blueprint is a guide, not a permission to fill gaps with plausible behavior.

---

## 11. Deviation record

Every implementation difference should be recorded in a table like this:

| Location | Blueprint requirement | Actual behavior | Reason | Decision needed? |
| --- | --- | --- | --- | --- |
| `path/to/file` | Required symbol or ownership rule | What was built | Constraint or discovered fact | Yes / No |

Small formatting differences do not need a deviation entry. Differences in behavior, ownership, dependencies, failure meaning, persistence, security, or verification do.

If the implementation exposes a missing architectural or behavioral decision, stop at the boundary, record the question, and update the authoritative document before updating the blueprint.

---

## 12. Completion criteria

A blueprint is complete enough for a first pass when:

- The exemplar workflow is concrete and bounded.
- The authority documents are linked and contradictions are visible.
- Every required file has a responsibility and owner.
- No file is present only because a template usually contains it.
- Every public symbol has an input, output, behavior, refusal, and verification description.
- Important internal symbols and dependency seams are described.
- State transitions and version/concurrency rules are explicit where relevant.
- Persistence, transport, external effects, and composition are assigned to owners.
- Side-effect ordering and uncertain outcomes are stated.
- Required, optional, deferred, and forbidden work are distinguished.
- A developer can follow the construction order without needing to invent the basic design.
- The document says what it does not specify.

Completion does not mean every future concern has been solved. It means the first implementation can proceed with its remaining uncertainty visible and bounded.

---

## 13. Review questions

Before using a blueprint, ask:

- Could two implementers produce materially different behavior from this document?
- Does every important rule have one owner?
- Does the file tree expose the actual architecture rather than an idealized template?
- Are failure paths described as carefully as success paths?
- Does the blueprint say what happens after a timeout or uncertain commit?
- Are security, privacy, authorization, and data-retention consequences assigned?
- Does each abstraction protect a real boundary?
- Can the exemplar be verified before the rest of the system exists?
- Which statements are established facts, and which are still proposals?
- What is intentionally not being built?

If the answer to an important question is unknown, keep it visible in `Open decisions and unknowns`; do not hide it by writing a more detailed-looking file description.
