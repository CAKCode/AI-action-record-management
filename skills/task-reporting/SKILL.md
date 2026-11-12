---
name: task-reporting
description: Standardize structured business reports in managed Tasks using five reusable report card templates. Use when registering test results, deployment outcomes, failure analysis, workflow progress, or other business results; supports all business areas and preserves the actual publishing Skill identity.
---

# Task Reporting

Use this common reporting contract alongside the Skill that performs the business work. The business Skill owns the real command and outcome; this Skill supplies the registration format. The platform owns display, revisions, artifact registration and archival.

## Select a card

| Card | `reportType` | Main content |
| --- | --- | --- |
| Test result | `test-result` | Per-run counts, case outcomes, HTML reports |
| Deployment result | `deployment-result` | Targets, components, versions, start/end times and outcome |
| Failure analysis | `failure-analysis` | Findings, expected/actual behavior, evidence and next action |
| Workflow progress | `workflow-progress` | Business-defined stages, current progress and final outcome |
| Business result | `business-result` | Results that do not fit the other four cards |

Choose by the operation being reported, independently of project and Skill name. Custom and historical `reportType` values remain supported and display with the business-result layout. These five types standardize presentation; they do not introduce a publication allowlist.

The fixed content contract is **Card Templates v1**, using Schema v2. Generate it with
`codex-skill-report template --data <observed-results.json>`; the helper fixes metric order,
labels and the primary section's columns. Use `--preset rerun` for test reruns and
`--preset final-summary` for the workflow's final card. `codex-skill-report cards` prints the
catalog. Read [references/cards.md](references/cards.md) for fields and the seven runnable
examples. Put additional business facts in `context`, `evidence` or extra `sections`.

## Register

Generate the skeleton with the platform helper, wrapped by the actual business Skill:

```bash
codex-skill-use <business-skill> -- codex-skill-report template \
  --type test-result --report-key <logical-run-key> --status running \
  --external-attempt <TRACKING_ID> --output <run-dir>/report.json
```

The helper takes `skillId` from the active business Skill; `--skill-id` also supports preparing a template locally. It generates Schema v2 without calling a model or publishing anything. Fill the title, summary, metrics, sections and execution fields from actual results, then publish:

```bash
codex-skill-use <business-skill> -- codex-skill-report publish --file <run-dir>/report.json
```

Read [references/cards.md](references/cards.md) when filling a card. Keep one stable `reportKey` through the running and terminal revisions of a logical report; give separate executions and business reruns their own keys. Background reports link their registered execution using `executionEvidence.externalAttemptId`; foreground-produced analysis files use the actual completed command's `executionEvidence.commandExecutionId`. Select one execution identity per report. Technical retries remain generations of their Step Run.

Organize visible reports by business stage. One execution with several HTML outputs uses one report
with all its registered files. When a stage spans independent executions, its owner publishes one
stage card with `relatedReportKeys` listing their report keys; the platform folds those reports into
the stage's expandable execution details and collects their file links. The stage aggregate uses
`artifacts: []` and no fabricated execution identity. Each child retains its real publisher,
External Attempt and artifact registrations. Stage totals come from the workflow ledger, not by
adding initial runs and reruns together. Do not create separate cards for preflight, collection,
polling, archive checks, file inventories or final evidence; keep them in stage details or Worklog.
Reuse one final-summary key rather than publishing a second final-evidence report.

Keep the exact command in `primaryExecution`, not repeated in a second execution section. Put results in `summary`, `metrics`, and business sections. Unknown counts stay absent instead of becoming zero. Extra business fields remain supported in sections, and the complete payload remains available.

Running reports use `artifacts: []`. Register each known pytest HTML at launch with repeated `codex-background-track register --artifact` options. Terminal reports inherit those registrations; explicitly add later-created standalone analysis HTML as `failure-analysis-html`, or Markdown as `failure-analysis-markdown` when that format was requested. Preserve every file's own stable artifact key and original filename. Report publication and file archival have separate states.

Analysis HTML is attached directly in its analysis card's `artifacts`, using the same managed archive and report-viewer flow as pytest reports. Put the actual producing command's `commandExecutionId` in the `--data` file; the template retains it. An analysis spanning multiple test Runs still has its own file-producing execution, so it does not need a single upstream External Attempt. The empty-artifact rule for cross-stage summaries does not remove the analysis report's own file. See [Foreground analysis HTML](references/cards.md#foreground-analysis-html) for the command lookup, payload and publish example. A path in a section or a file reply is additional evidence, not an attached report.

Use the existing business workflow's publication timing. Deployment Skills keep their start/end pair; reading this Skill does not add polling Turns, extra model calls or intermediate deployment publications. This shared Skill is a format helper and does not replace the actual publisher with `task-reporting`.

Updated source Skills apply to subsequently frozen Task snapshots. Existing snapshots remain unchanged.
