# Working rule: build in large batches, no stacked PRs

- `[qa]` `CLAUDE.md` and `decision_log.md`: a multi-phase build is one branch and one PR against main, phases as commits; never a PR based on another PR's branch. Two of the five stacked admin PRs missed main on 2026-11-09 and were re-landed as #740.
