# Architecture: grant target guard

## Data flow (consequential action with a target)

```
execute(command)
  evidence   = collectEngineEvidence(...)            (unchanged)
  policy     = kernel.classify(request)               (no detail needed)
  if consequential:
    before   = guard(nodeId)   ── engine.snapshot({interactive:false})
                                  targetGuard(tree, ref)
    refuse if before.name ≠ perceived label           (page changed since perceive)
    detail   = describer.describe(cmd, type, contextOf(before))
  decision   = kernel.requestGrant(request + detail)  (human waits here)
  if consequential:
    after    = guard(nodeId)   ── fresh snapshot again
    refuse if guardDiff(before, after) is not empty
  engine.act(click ref)                                (same ref string just verified)
```

## Components

| Unit | Where | Kind |
|---|---|---|
| `targetGuard(tree, ref)`, `guardDiff`, `guardContext` | `packages/action/src/target-guard.ts` | pure, no engine |
| guard calls around `requestGrant` | `GovernedActuator.execute` | wiring |
| optional `context` arg to `ActionDescriber.describe` | `governed-actuator.ts`, `build-on-session.ts` | wiring |

## Guard contents

- `role`, `name` of the ref's line.
- `state`: whitelisted flags only (`checked disabled expanded selected pressed
  required readonly`) so transient flags cannot cause refusals.
- `ancestors`: names of enclosing lines (dialog "Confirm", form "Pay").
- `before`: text of the lines between the previous line that has a ref and the
  target, nearest 300 characters. agent-browser flattens generic `div`s, so
  structural containers are not reliable; the text right before a control is.

## Why the ref stays valid

agent-browser assigns the same refs to the same elements in `-i` and full
snapshots of an unchanged page (observed). The click uses the ref string that
the post-grant snapshot just verified, so the window is one CLI round trip.
