# Clock module notes

The clock is a framework-free shared leaf. It separates wall timestamps from
monotonic elapsed measurements and gives tests explicit control without global
fake timers.

- [Language walkthrough](language-walkthrough.md): Date ownership, private fields
  and bigint elapsed units.
- [First slice](first-slice.md): scope, ordering and why this comes before IDs
  and provenance.

The executable behavior lives in [`src/shared/clock/`](../../../../../src/shared/clock/).
