# Test plan: grant target guard

## Pure (`packages/action/src/target-guard.test.ts`, verbatim agent-browser trees)

1. Finds the ref's role, name, whitelisted state; ignores `level`, other flags.
2. `before` = text since the previous ref'd line (list rows, flattened div rows).
3. `before` keeps the nearest 300 characters.
4. `ancestors` = names of enclosing lines only.
5. Unknown ref → `undefined`.
6. `guardDiff`: row swap under an identical label → different; unchanged → same;
   checked→unchecked → different.

## Actuator (`governed-actuator.test.ts`, fake engine)

7. Consequential: page unchanged during the wait → clicks.
8. Consequential: `before` changes during the wait → `element_gone`, no click, message names the change.
9. Consequential: label differs from the perceived node before the grant → refused, no grant asked.
10. Consequential: ref gone after the grant → `element_gone`, no click.
11. Benign: no full snapshot is taken.
12. Approval text carries `next to: …`.

## Live (`LATTICE_LIVE_ENGINE=1`, `grant-target-guard.live.test.ts`)

13. Four variants (rebuild/reuse × identical/unique labels): after the fix every
    variant either deletes Alpha or refuses and deletes nothing. Before the fix:
    3/4 deleted Gamma (recorded 23.09.2026).
14. A page that does not change during the wait still executes (no false refusal).

## Gates

`pnpm build`, `pnpm test`, `pnpm lint`.

## Results (23.09.2026)

- Pure + actuator: `target-guard.test.ts` 10, `governed-actuator.test.ts` 36 (7 new), all pass.
- Live, agent-browser 0.31: all four variants refuse and delete nothing; the
  still page executes and deletes Alpha. Before the fix, 3 of 4 variants deleted
  Gamma under an approval for Alpha.
