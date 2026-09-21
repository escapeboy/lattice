# Frames: what ships now, and what frame-aware perception would cost

## What ships now

Any action whose target resolves inside an iframe is **consequential**, same-origin
or cross-origin alike. A framed *read* is still a read — this raises the ceiling on
acting, not on looking. Implemented in `packages/kernel/src/effect.ts`, probe support
in `packages/action/src/effect-probe.ts`, tested in `effect.test.ts` and
`pointer-target.integration.test.ts`.

The rule is deliberately blunt because the alternative is worse: today we cannot tell
an embedded payment form from a comment widget, so the operator gets asked.

## The blind spot, measured

A throwaway probe against a page holding one same-site and one cross-site iframe,
each containing a button and a text input:

```
IG nodes: 1
  button       "MAIN-FRAME-BUTTON"

sees main button : true
sees inner button: false
sees inner input : false

Page.getFrameTree: 2 frames          <- main + the same-SITE frame only
Target.getTargets: 1 iframe target   <- the cross-site frame is an OOPIF
```

Three things worth naming:

1. **Frame contents are entirely invisible.** Not degraded — absent.
2. **The `<iframe>` element itself does not reach the IG either**, even with a
   `title`. So today an agent cannot even see that there is a box it cannot look in.
   The gate's iframe rule only fires when the *probe* resolves a target into a frame.
3. **Chrome splits frames by site, not origin.** `127.0.0.1:63949` inside
   `127.0.0.1:63951` stayed in-process despite being a different origin;
   `localhost` inside `127.0.0.1` became an out-of-process frame. Any design that
   reasons about "same origin" will get this wrong.

## What frame-aware perception needs

### 1. Same-site frames — small

`Accessibility.getFullAXTree` already takes a `frameId`, and it works today:

```
getFullAXTree(frameId=<main>):  8 nodes, has INNER=false
getFullAXTree(frameId=<child>): 9 nodes, has INNER=true
```

So for same-site frames the work is: walk `Page.getFrameTree`, call `getFullAXTree`
per frame, merge. `DOMSnapshot.captureSnapshot` is already whole-page and keyed by
`backendNodeId`, so href and clickability come along.

**Effort: 1–2 days.** Mostly plumbing a `frameId` through `ax-tree.ts` and deciding
merge order.

### 2. Cross-site frames (OOPIFs) — the real work

A cross-site frame is a separate CDP target with its own session. Reaching it means
`Target.setAutoAttach({autoAttach: true, flatten: true, waitForDebuggerOnStart: false})`,
then routing every message by `sessionId`. That is a change to the CDP client, not to
perception — today `cdp.send` has no session concept.

Knock-on effects:

- **Every perception call multiplies.** One `getFullAXTree` becomes one per target,
  and they cannot be batched. A page with a consent iframe, two ad iframes and a chat
  widget goes from 1 round trip to 5.
- **Coordinates need translating.** A click inside an OOPIF is dispatched to that
  frame's session in *its own* coordinate space. `pointer-target.ts` computes
  main-frame viewport coordinates today; framed targets need the frame's offset.
- **Lifecycle races.** Ad and consent iframes attach, detach and re-attach constantly.
  Auto-attach fires while a snapshot is mid-flight.

**Effort: 1–2 weeks**, most of it in the CDP client and in `pointer-target.ts`, not in
building the tree.

### 3. Node identity across frames — the part that looks easy and is not

`computeNodeId` (`packages/perception/src/identity.ts`) keys on `backendDOMNodeId`
when present, and falls back to a hash of role, name, href, ancestor roles and
ordinal.

**`backendDOMNodeId` is only unique within a target.** Merge two OOPIF trees and two
different nodes can collide on the same id — the same identifier resolving to a
button in the consent frame and a button in the ad frame. The fallback hash collides
just as readily: two ad iframes from the same network produce byte-identical subtrees,
so identical role, name, href, ancestor roles and ordinal.

The fix is to make the frame part of the key (`frame:<frameId>:bdn:<id>`), which is
easy to write. What is *not* easy: `frameId` changes when a frame navigates, and
consent and ad frames navigate constantly. So node ids would churn across snapshots
for exactly the frames most likely to hold something worth clicking, and any cache or
recipe keyed on a node id breaks in a way that looks like flakiness.

**Effort: 3–5 days** for the key change, plus an unknown amount for the churn. This is
the item I would not commit a date to.

## Risks

| risk | why it matters |
|---|---|
| **Identity collisions across merged frames** | Two nodes sharing an id means an agent can click the wrong one. This is a correctness bug that presents as flakiness, and it is the reason not to ship a naive merge. |
| **The gate gets weaker the moment it lands** | Today "inside a frame" *is* the signal. Once frames are perceived, the rule has to be replaced by real classification of framed content — which is precisely what we cannot do well. Shipping perception without a replacement rule silently downgrades every framed action to benign. |
| **Attack surface** | A hostile page controls the content of its iframes. Perceiving them means feeding attacker-authored labels into the agent's context — the same injection surface as the main page, but from an origin the page does not own. |
| **Cost** | 5× the CDP round trips on an ad-heavy page, on every snapshot. |

## Recommendation

Do **(1)** — same-site frames — because it is cheap, it closes the common case
(consent dialogs, which the held-out set showed are usually same-site), and it does
not need the CDP client to change.

Do **not** do (2) until there is a replacement classification rule for framed
content. The current blunt rule is the only thing standing between an agent and an
embedded payment form, and perceiving OOPIFs without replacing it makes the system
less safe, not more.

Fix **(3)** — frame-scoped node identity — *before* either, since it is a latent
correctness bug the moment any frame merging happens.
