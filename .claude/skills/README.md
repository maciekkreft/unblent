# Skills in this folder

- `build-evals-interface` is written for this repository. It adapts the `build-review-interface`
  skill from ai-evals-course/evals-skills to unblent's architecture; the original is not copied,
  so only one of the two can trigger.
- The other eight skills are copied unchanged from https://github.com/ai-evals-course/evals-skills
  (Apache License 2.0, see `LICENSE-evals-skills`), cloned 2026-10-02. `evals-start` is their
  entry point and routes to the others.
- Whatever a skill says, `architecture.md` wins: contracts before code, permission before any new
  event, token or icon, `python3 checks/check.py --changed` before anything is reported done.
