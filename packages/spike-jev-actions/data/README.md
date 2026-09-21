# Held-out gate evaluation set

`heldout-cases.jsonl` — 78 pending-action snapshots captured from 25 origins, none of
which appear in the 150-case set the effect gate was tuned on. 46 cases are from
Bulgarian-language sites (banking, e-shops, municipal e-services, telecom self-care),
32 from English-language ones. All captures are logged out; no credentials, no personas.

`heldout-labels.jsonl` — the hand-assigned ground truth, one line per case id.
**These labels were committed before the classifier was run against this set**, so the
order is auditable in git history: this commit holds the labels only, the classifier's
output lands in a later commit.

Labels marked `BORDERLINE` in the `why` field are judgement calls a human reviewer
should overrule if they disagree; they are not settled.
