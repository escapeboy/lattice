# Test plan: grant target guard

## Pure (`packages/action/src/target-guard.test.ts`, verbatim agent-browser trees)

1. Finds the ref's role, name, whitelisted state; ignores `level`, other flags.
2. `before` = text since the previous ref'd line, that line's name included
   (list rows, flattened div rows, rows named by a link or heading with a ref).
3. `before` keeps the nearest 300 characters.
4. `ancestors` = names of enclosing lines only.
5. Unknown ref → `undefined`.
6. `guardDiff`: row swap under an identical label → different; unchanged → same;
   checked→unchecked → different; mixed→checked → different.

## Actuator (`governed-actuator.test.ts`, fake engine)

7. Consequential: page unchanged during the wait → clicks.
8. Consequential: `before` changes during the wait → `element_gone`, no click, message names the change.
9. Consequential: label differs from the perceived node before the grant → refused, no grant asked.
10. Consequential: ref gone after the grant → `element_gone`, no click.
11. Benign: no full snapshot is taken.
12. Approval text carries `next to: <before> [here] <after>`; for a row named
    after its button, it does not name only the previous row.

## Live (`LATTICE_LIVE_ENGINE=1`, `grant-target-guard.live.test.ts`)

13. Variants (rebuild/reuse × identical/unique labels, plus rows named by a
    link): after the fix every
    variant either deletes Alpha or refuses and deletes nothing. Before the fix:
    3/4 deleted Gamma (recorded 23.09.2026).
14. A page that does not change during the wait still executes (no false refusal).

## Gates

`pnpm build`, `pnpm test`, `pnpm lint`.

## Results (23.09.2026)

- Pure + actuator: `target-guard.test.ts` 10, `governed-actuator.test.ts` 36 (7 new), all pass.
- Live, agent-browser 0.31: all 8 shapes (rebuild/reuse × identical/unique
  labels × name before/after the button) refuse and delete nothing; the still
  page executes and deletes Alpha. Before the guard, 3 of the 4 name-before
  shapes deleted Gamma; before `0e08c9b`, both name-after shapes did.
- Workspace: build 0, lint 0, 706 passed / 23 skipped.

## Review follow-up (23.09.2026)

- A row named by a link or heading gives that control its own ref, so the
  guard's text stopped short of the row name: `before` and `after` were both
  `•`. Live: the two link-named variants **executed** the approved click after
  the rows re-rendered. The guard now keeps the neighbouring ref'd line's name;
  both variants refuse. Live suite: 11/11.
- `checked=mixed` was read as `checked`; now kept as `checked=mixed`.
- The approval text showed only the text before the control, which for a row
  named after its button is the previous row's name. It now shows both sides.
