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

Read [references/cards.md](references/cards.md) when filling a card. Keep one stable `reportKey` through the running and terminal revisions of a logical report; give separate executions and business reruns their own keys. Link the same registered execution using `executionEvidence.externalAttemptId`. Technical retries remain generations of their Step Run.

Keep the exact command in `primaryExecution`, not repeated in a second execution section. Put results in `summary`, `metrics`, and business sections. Unknown counts stay absent instead of becoming zero. Extra business fields remain supported in sections, and the complete payload remains available.

Running reports use `artifacts: []`. Register each known HTML at launch with repeated `codex-background-track register --artifact` options. Terminal reports inherit those registrations; explicitly add later-created analysis Markdown. Preserve every file's own stable artifact key and original filename. Report publication and file archival have separate states.

Use the existing business workflow's publication timing. Deployment Skills keep their start/end pair; reading this Skill does not add polling Turns, extra model calls or intermediate deployment publications. This shared Skill is a format helper and does not replace the actual publisher with `task-reporting`.

Updated source Skills apply to subsequently frozen Task snapshots. Existing snapshots remain unchanged.
