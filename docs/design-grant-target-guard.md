# Design: the approved target is the clicked target

Source: `claudedocs/research_jev-ultrafast_2026-09-23.md` §2.1 (idea borrowed from
jev-ultrafast's per-element `guard` + `fresh()` check).

## Problem

A consequential action waits for a human in `kernel.requestGrant()`. That can take
minutes. After the grant, `GovernedActuator` clicks the agent-browser ref it had
before the wait, with no check that the ref still means the same control.

Reproduced live (`packages/gateway/src/grant-target-guard.live.test.ts`, real
agent-browser 0.31): three rows, each with a Delete button. The human approves
Delete on the Alpha row; the list re-renders during the wait; the click deletes
**Gamma**. It happens in 3 of 4 variants, including unique labels ("Delete Alpha")
when the page reuses DOM nodes, as virtualised lists do.

## Who is affected

Anyone approving a consequential action on a page that updates on its own: lists
that re-sort, feeds, virtualised tables, SPAs that re-render after a poll. The
approval log then records "approved" for an action the human did not approve.

## Narrowest fix

Before the grant, record what the target is: role, name, state and the page
text on either side of it, up to the neighbouring controls. After the grant, read it again from a fresh
snapshot. Same → click. Different → refuse with `element_gone` / `re-perceive`,
naming what changed. Refused beats wrong, as in commit `27f5ef4`.

Also show that text in the approval (`Click 'Delete' — next to: Alpha`), because
the human cannot tell rows apart from "Click 'Delete'" alone.

## Out of scope

- Benign/auto-granted actions. Their race window is the agent's own
  perceive→act gap, and a full snapshot on every click costs time. Revisit after
  measuring.
- Re-locating the approved target at its new position. Refusing is simpler and
  cannot pick the wrong one.
- Control-plane / Swift schema changes; the context rides the existing `action`
  string.

## Known cost

Text around the target is compared exactly, up to the neighbouring controls,
so a change at the start of the next row also refuses. A live countdown or ticker
next to a consequential control will make every approval refuse. That fails
closed and says why; it is recorded as a residual, not hidden.

## Dropped: post-action wait (research §2.2)

The shipped path (desktop, `engineKind: "agent-browser"`) has no Lattice-side
wait after an action; agent-browser settles internally. `waitNetworkIdle` is
only in the legacy CDP `ActionExecutor`. Nothing to tune on the path users run.

## Found on the way

- `parseSnapshotTree` lost the ref and state of every node with a second
  attribute (`[checked=true, ref=e1]`). Fixed in `9374de0`.
- That fix, and the name pattern on main, let page text pick a node's ref: a
  value `hi [ref=e5]` or a label with escaped quotes. Fixed in `8f063bb`.
- Two live tests in `build-on-session.test.ts` were red on main since `cd1f5bb`.
  Fixed in `9539079`.
