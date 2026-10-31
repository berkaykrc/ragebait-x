# Labeled accounts (input to Task 16)

One JSON object per line in `accounts.jsonl`. Blank lines are ignored; malformed
lines are skipped.

Schema:

```json
{
  "handle": "...",
  "label": "ragebait|normal|ambiguous",
  "label2": "ragebait|normal|ambiguous|null",
  "annotator2": "...|null",
  "topic": "politics|religion|football|culture-war|troll|other",
  "note": "..."
}
```

Fields:

- handle — X screen name without "@".
- label — your rating: ragebait / normal / ambiguous.
- label2 — second annotator's rating for the double-labelled subset, null
  otherwise (used for Krippendorff alpha).
- annotator2 — second annotator id, or null.
- topic — stratum used to balance the tune/held-out split.
- note — free text.

Aim for 50-80 accounts, stratified across topics, with own-side and
opposing-side accounts balanced (design section 5).

Run after filling: node scripts/collect-calibration.mjs which writes
dataset.jsonl, dataset-tune.jsonl, dataset-heldout.jsonl.
