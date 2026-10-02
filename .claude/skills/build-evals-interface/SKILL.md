---
name: build-evals-interface
description: Build, inside unblent's slip-box architecture, the components for running and reviewing decision experiments: datasets of labelled items, experiments that run several deciders (Jev through typesafe.ai or classifier.dev, OpenAI Decisions API, Laya-MLX locally, LLM function calling, optionally CUA-S1) over a dataset many times, a one-item-at-a-time review view with Pass/Fail/Defer and keyboard shortcuts, and a results view with the few metrics Hamel Husain's evals method asks for. Adapted from ai-evals-course/evals-skills build-review-interface.
---

# Build the evals interface in unblent

This skill adapts Hamel Husain's "build a custom annotation interface" to this repository.
The original is one HTML file that loads traces, shows one at a time, takes Pass/Fail and a note,
and persists labels. Here the same job is split the way `architecture.md` splits everything:
facts own the data, views own one way of looking at it, and they meet only on the bus.

**`architecture.md` is the spec and it wins over this skill wherever the two differ.** Read it
first. Section 9 governs the order of work: contracts before code, and step 2, reviewing the
planned components on the components page, belongs to the user. Every new event, token or icon
needs the user's explicit permission (7.1, 7.4, 7.6). Where the architecture is silent, propose
the amendment and wait; never improvise (CLAUDE.md). `python3 checks/check.py --changed` must
pass before any step is reported done.

## What is being built, in one paragraph

A **decision task** is a question with a finite answer space asked about one piece of text
(for example: "which cognitive distortion, if any, does this sentence show?"). A **dataset** is a
versioned list of items, each with the text and its gold answer. A **decider** is anything that
answers the question. An **experiment** pins one dataset version, one decider configuration and
a number of runs, then records every answer with confidence, latency and cost. A **review** is a
human verdict on one item's answers, Pass or Fail, with a note. The **results** are a few
numbers computed from the records, described below, chosen by Hamel's rule: measure what you
need to make the next decision, nothing more.

Everything is generic over the label set, so the same components later serve a different
question (is this reply worth answering, did the agent remember the fact) with a new dataset only.

## Components

Three fact components and three view components. Names are proposals for step 1; the user
settles them on the components page.

### Facts

| Component | Shape | Owns |
|---|---|---|
| `datasets` | remote-only | labelled items, versioned; clone-and-lineage like unblent-eval |
| `experiments` | remote-only | experiment definitions, their runs and every recorded answer |
| `reviews` | replicated | human verdicts and notes per item per experiment |

`datasets` and `experiments` are remote-only because the deciders run on the server, where the
provider keys live, and a run must survive a closed tab. `reviews` is replicated so grading
works offline and syncs later, the same as `notes`.

Each fact brings its own `server/router.py` at `/api/<component>` and its own SQLite schema
(11.1). Provider keys are machine settings in `.env` (11.1), never in a reply. Any field
carrying a key or a raw provider token in a payload is marked `x-secret` (7.2).

### Views

| Component | Shows | Role |
|---|---|---|
| `item-review` | one item at a time: text, gold answer, each decider's answer with confidence, verdict controls | `review` |
| `experiment-list` | experiments and their state, pick one to review or inspect | — |
| `experiment-results` | the results table for one or two experiments | — |

Views own only UI state (which item, scroll, the draft note). Verdicts belong to `reviews`.

## Contracts to propose (step 1)

Write these as planned components, `machine.js` with metadata and the schemas, nothing else,
and stop for the user's review. Names follow `subject.pastTenseVerb`.

Events, owner in brackets:

- `dataset.changed` [datasets]: the whole dataset header (id, version, size, label set).
- `experiment.changed` [experiments]: the whole experiment header including state and progress
  (`queued`, `running`, `done`, `failed`; items done, items total, runs done, runs total).
- `item.selected` [item-review]: experiment id, item id. The gesture.
- `review.saved` [item-review]: experiment id, item id, verdict (`pass`, `fail`, `defer`), note.
  The whole review, self-contained (4.3).
- `review.changed` [reviews]: the review as stored, with version.
- `experiment.selected` [experiment-list]: experiment id. The gesture.

Queries, answerer in brackets, each in `queries/<name>.json` with `payload`, `reply`,
`supersededBy`:

- `datasets: list`, `datasets: read(id, version)`; superseded by `dataset.changed`.
- `experiments: list`, `experiments: read(id)`; superseded by `experiment.changed`.
- `experiments: answers(id, itemId)`: every decider answer for one item across runs.
- `experiments: results(id)`: the results object described below; superseded by
  `experiment.changed` and `review.changed`.
- `reviews: read(experimentId, itemId)`, `reviews: stats(experimentId)`: labelled, unlabelled,
  deferred counts; superseded by `review.changed`.

Commands: `item-review: load(experimentId, itemId)`, `item-review: focus`.

Check on the components and contracts page: does anything here duplicate `trace`,
`conversations` or `llm`? `llm` owns chat completion and the account's chat model settings; the
deciders are a different fact and must not be wrapped around `llm: complete`. If the user
decides otherwise, that is a contract change and is decided before code.

## Deciders (server side of `experiments`)

One interface, several adapters, one file each under `components/experiments/server/deciders/`:

```
decide(question, options, context) -> { choice, confidence | null, latency_ms, cost_usd, raw }
```

Hosted:

- `typesafe_jev`: Jev through typesafe.ai's own API. Typed decision with calibrated probability.
  Read the current API from their docs at build time; do not guess the endpoint.
- `classifier_dev`: the same vendor's zero-shot classification endpoint (`classifier.dev`),
  text plus labels in, a calibrated probability per label out; model selectable among Jev, Laya
  and Kev. Has a free tier, so it is the cheapest first arm to wire.
- `openai_decisions`: the Decisions API (limited preview). Finite answer space, context as text.
- `openai_tools`, `anthropic_tools`: an LLM forced to call one tool whose single parameter is an
  enum of the options; the tool's arguments are the decision. Model, temperature and the prompt
  are part of the experiment configuration, so a tuning pass is a new experiment, not an edit.

Open source, local:

- `laya_mlx`: Laya typed decision models on Apple Silicon through `laya-mlx` (Apache 2.0),
  `choice`, `score` and `noul` question types, probabilities over options, no network. Run as a
  small local process the server module talks to over HTTP, never imported into the FastAPI
  process, so a crash or a model load never takes the server down.
- `cua_s1` (optional, later): Cua's System 1 model for bounded decisions over interface
  elements. Same shape of question; included so the interface is proven generic, not because it
  is expected to do well on text.

Test:

- `echo`: deterministic, no key, no network, the same role Echo plays for chat (12).

A run asks every item once; an experiment with `runs = 30` asks every item thirty times. Record
each answer as its own row: experiment, run index, item, choice, confidence, latency, cost,
raw response, timestamp. Never overwrite; results are computed, not stored.

Confidence is the adapter's own number when the provider gives one, the probability of the
chosen enum when the provider exposes log-probabilities, otherwise null.

## Results (the `results` query), kept to what decides the next step

Hamel's guidance, in the notes this repository's owner keeps: binary Pass/Fail over scales,
look at the data before trusting a number, count failure prevalence, use a bootstrap for
uncertainty, and distrust off-the-shelf metrics that sound useful. This task is the one case
where reference-based measurement is right, because each item has a single correct answer. So:

Headline, always shown:

- **Correct rate**: correct answers over all answers, with a 95 percent bootstrap interval,
  resampling items with replacement, exactly as the notes describe.
- **Confusion table**: gold label by chosen label, as counts. This is where the failure modes
  are, and it replaces a wall of per-class scores.
- **Cost per thousand items** and **latency p50 and p95**.
- **Same answer across runs**: how often an item got the same answer in every run, as a
  percentage. For deterministic deciders this is 100 and says so.

Shown only when the question needs it:

- **Confidence, plainly**: for answers that carried a confidence, bins of stated confidence
  against the share that were correct ("when it said at least 90 percent, it was right 71
  percent of the time"). No expected-calibration-error number; the table is the finding. This
  exists because calibrated confidence is the vendors' central claim, and the study tests it.
- **Human agreement with the gold labels**: the reviewer re-labels a sample through
  `item-review`, and Cohen's kappa between the reviewer and the dataset is reported per label
  set. The notes warn that gold labels are themselves a judgment; for cognitive distortions
  this check is not optional, and a kappa well below 0.6 stops the study until the labels are
  fixed.
- **Failure prevalence**: after open coding of the Fail notes, when tags exist, the count of each
  tag over all reviewed items.

Not built unless asked: macro F1, per-class F1, expected calibration error, leaderboards.

Two experiments compared side by side align items by dataset lineage, as unblent-eval does.

## The review view (`item-review`)

Keep the original skill's rules; they are the point of the exercise.

- One item at a time. Primary content, the text, visually dominant. Gold answer in a toggleable
  reference panel, closed by default so the grader reads the text first.
- Each decider's answers across runs collapsed to one row: majority choice, agreement, mean
  confidence; expand to see the runs and the raw response. Raw provider output is rendered as
  text, never as HTML.
- Verdict controls: Pass, Fail, Defer, distinct and large. Free-text note for open coding.
  Auto-save on every action by emitting `review.saved`; there is no save button to forget.
- Navigation: previous and next, a counter ("12 of 87 remaining"), jump to item id, labelled
  and unlabelled counts from `reviews: stats`.
- Keyboard: arrows navigate, `1` pass, `2` fail, `d` defer, `u` undo, `Cmd+S` save,
  `Cmd+Enter` save and next. When "Vim keys" is on (`settings: read`), `j`/`k` also navigate.
- Sampling is not the view's business. Which items appear, in which order, is a dataset or
  experiment setting; start with a seeded random order.
- Failure tags come later, after failure patterns emerge from the notes (open coding, then axial
  coding). Do not add a tag set now.

Tokens and icons: use only existing tokens (7.4). If a new icon is needed, propose its Phosphor
name with the link and wait.

## Order of work (section 9)

1. Planned components: directories, `machine.js` with metadata, `events/`, `queries/`,
   `commands/`. Run `python3 checks/show.py contracts` and stop. The user reviews on the
   components page.
2. After approval: `datasets` actor, store and server module, with the `echo` decider and the
   dataset import (CSV or JSON: `id`, `text`, `label`, optional `split`). Node tests.
3. `experiments`: actor and server module, run loop with the `echo` decider, `results` query with
   the headline numbers. Metrics tests in Python against hand-computed fixtures, including the
   bootstrap with a fixed seed.
4. `reviews`: actor, store, server module, sync. Node tests.
5. `item-review`, then `experiment-list`, then `experiment-results`. Browser tests in Playwright:
   load, label, navigate, every shortcut, persistence across reload, expand collapsed content.
6. Real adapters one at a time, `classifier_dev` first because it is free, each behind its
   `.env` key, each with a recorded fixture so tests never spend money. `laya_mlx` as a
   separate local process with its own start command in the Makefile or CLAUDE.md.
7. Put the views on a workshop app page, review on the desk and the phone preview, then report.

## Testing checklist, from the original skill

Consistent layout, distinct verdict buttons, full keyboard coverage, accessible focus order,
auto-persistence with no manual save, item-level annotation, native rendering of the domain
format, screenshots reviewed for hierarchy and readability, and one Playwright run covering the
whole grading loop.
