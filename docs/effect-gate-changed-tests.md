# Every existing test whose expected behaviour changed on `fix/effect-gate`

For human review. Branch point: `a95b0d4`.

New test files are **not** listed here — they assert new behaviour and nothing was
overruled to add them. What follows is only the tests that already existed and now
expect something different. There are **8** of them across 6 files, plus 4 fixture
changes that altered no assertion but did change what a test exercises.

The single cause behind almost all of it: **the gate used to classify on the verb
name, and now classifies on the target.** `act` on a Submit button used to be benign
because the verb was cheap. It is now consequential because of what the control is.
Tests that used the cheap verb to get through a gate they were not testing had to
stop doing that.

---

## A. Assertions that changed value

### 1. `packages/gateway/src/build-on-engine.test.ts` — node counts

| | |
|---|---|
| **old** | `expect(l1.nodes.size).toBe(2)` |
| **new** | `expect(l1.nodes.size).toBe(3)` |
| **old** | `if (l0.tier === "L0") expect(l0.interactiveCount).toBe(2)` |
| **new** | `if (l0.tier === "L0") expect(l0.interactiveCount).toBe(3)` |

**Why:** the fixture tree gained a third node, `- link "Home" [ref=e3]`. The counts
follow the fixture; no perception behaviour changed. **Low risk** — but it is a real
assertion edit, so it is listed.

### 2. `packages/action/src/governed-actuator.test.ts` — renamed expectation

| | |
|---|---|
| **old** | `it("EFFECT-GATE: a click on a NON-submit control stays benign (auto-granted)")`, with the comment *"submitRefs empty → getAttr type = undefined → benign, no grant needed"* |
| **new** | `it("EFFECT-GATE: a click on a control KNOWN not to commit stays benign (auto-granted)")`, with *"Perception says: a link, same origin, neutral label. Nothing raises it."* |

**Why:** the old test passed for the wrong reason. It got `benign` because the
actuator could not read the `type` attribute, i.e. **because the gate was blind**,
and the test encoded that blindness as the expected outcome. The new gate treats an
unreadable control as consequential, so the old test would now fail — and it should.
The replacement asserts the same outcome for a control perception can actually
describe.

**This is the one I would most want a second opinion on.** The assertion is
unchanged (`benign`, auto-granted); what changed is the input that earns it. A
reviewer could reasonably say the original test should have been deleted rather than
repaired.

---

## B. Tests where the target under test was swapped

In each of these the assertion is unchanged; the element it runs against changed,
because the original element is now correctly gated and the test is about something
else entirely.

### 3. `packages/gateway/src/build-on-concurrency.test.ts` — trace emission

| | |
|---|---|
| **old** | acts on `n.role === "button"` (the "Go" button) |
| **new** | acts on `n.role === "link"` (a "Home" link added to the fixture) |

The test asserts that a trace is emitted. Clicking a bare button is now
consequential, which would make it fail on governance rather than on tracing.

### 4. `packages/gateway/src/build-on-engine.test.ts` — two act-path tests

| | |
|---|---|
| **old** | `action.execute({ type: "act", target: { nodeId: firstButtonId(...) } })` |
| **new** | `action.execute({ type: "act", target: { nodeId: benignLinkId(...) } })` |

Applied in two places. A new helper `benignLinkId` was added. A **new** test was also
added asserting the Submit button now rejects — so the old behaviour is still covered,
just inverted and named.

### 5. `packages/gateway/src/build-on-gateway.test.ts` — MCP round trip

| | |
|---|---|
| **old** | `act_execute` on the button node, expected to succeed |
| **new** | `act_execute` on the link node, expected to succeed; **plus** a new assertion that the same call on the button matches `/prohibit\|grant\|block\|human/i` |

### 6. `packages/recipe/src/runner.test.ts` — recipe happy path

| | |
|---|---|
| **old** | `recipe([FILL_EMAIL, CLICK_SIGNIN])` |
| **new** | `recipe([FILL_EMAIL, CLICK_HELP])`, with a new `Help` link in `LOGIN_NODES` |

Applied to the happy-path test and to the drift test. A **new** invariant test was
added in the same file asserting that `act` on Sign in is denied exactly as `submit`
on it is — which is the bypass this branch closes, now pinned.

---

## C. Fixture and harness changes that altered behaviour without changing an assertion

### 7. `packages/gateway/src/build-on-session.test.ts` — kernel swapped

| | |
|---|---|
| **old** | `new BuildOnSession(engine, kernel(), ...)` |
| **new** | `new BuildOnSession(engine, granting, ...)` — a kernel with a `grantHandler` that returns `{ granted: true }` |

The only control in that fixture is labelled "Submit", which is now consequential.
The test is about ref re-anchoring, so the grant is approved rather than the fixture
changed. **Worth review:** this test now runs with a kernel that approves everything,
which weakens it as a governance test — though it never was one.

### 8. `packages/recipe/src/runner.test.ts` and `governed-actuator.test.ts` — `nodeFor` added to the fixture

Both fixtures gained a `nodeFor` on their `ReAnchor`, describing role / label / href
per node. Without it every target is an unknown, and unknown is consequential, so
these suites would have failed wholesale.

This is the change with the **widest blast radius and the least visibility**: it means
any *other* caller of `ReAnchor` that does not implement `nodeFor` will find its
actions classified consequential. That is the intended fail-safe direction, but it is
a behaviour change to the seam, not only to the tests.

---

## What was not touched

`packages/kernel/src/effect.test.ts` and the perception, backstop and pointer-target
files gained tests without any existing assertion being changed. The full suite runs
green: 17 packages, 686 passing, 14 skipped.
