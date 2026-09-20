# spike-jev-actions (THROWAWAY)

Measures whether "Jev picks the action, a small text model only writes typed
values, the kernel gates" is worth building into Lattice.

Hard boundaries this package respects:

- Nothing that ships imports it. It is absent from `tsconfig.json` references,
  has no `build` script (so the root `pnpm -r build` skips it), and the bun
  single-binary entry is `apps/serve/dist/main.js`, which never reaches here.
- It uses the kernel's classifier **read-only** (`classify()`); no kernel change.
- Every run uses a throwaway Playwright context: no persona, no vault, no
  imported Chrome profile, no logged-in state.

The taint rule is enforced in `taint.ts` and tested in `taint.test.ts`:
page-derived strings may appear only inside the Jev request's `state`. Question
`instructions` and `criteria` are assembled from static templates, the operator
goal, element indices, and the closed role vocabulary — never page text.
