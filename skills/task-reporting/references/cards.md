# Report card fields

All five cards use the existing Schema v2. The platform presents the type, business title, status, summary, metrics and artifacts in the same order, followed by execution evidence, business details and the full payload. It links the real execution to the report rather than displaying the same execution as a second large card. Executions that have no report remain visible.

## Shared fields

| Field | Fill with |
| --- | --- |
| `reportKey` | Stable identity of this logical report within its Run |
| `skillId` | Skill that actually performed the operation |
| `title` | Business-defined target, stage or execution name |
| `status` | Observed business outcome; Task review and archive status are separate |
| `summary` | One independently understandable conclusion from current evidence |
| `metrics` | Available measurements; omit unknown numbers |
| `primaryExecution` | Actual label, full command, working directory, command snapshot and known start/end/exit code |
| `executionEvidence` | Registered External Attempt identity, when this report is linked to an execution |
| `artifacts` | Explicit array; `[]` during running, terminal additions for later-created files |
| `sections` | Business facts using `fields`, `list`, `table` or `json` |

The helper's default `unknown` status and draft summary are scaffolding, not results. Replace them with observed state before registration. Preparing a template outside a managed Task is supported; publication continues to use the platform's existing managed runtime contract.

## Five templates

| Type | Default section | Suggested metrics | Fill section with |
| --- | --- | --- | --- |
| `test-result` | `case-results` table | passed, failed, skipped, errors, duration | Actual case / outcome / detail rows |
| `deployment-result` | `targets` table | duration, optionally observed target counts | Target / component / version / outcome rows |
| `failure-analysis` | `findings` table | Observed analyzed/failure counts | Case / classification / evidence / action rows |
| `workflow-progress` | `stages` table | Actual progress measurements, if available | Stage / outcome / detail rows |
| `business-result` | `details` fields | Business-defined measurements | Actual business results |

Section IDs make registration consistent but are presentation conventions, not a schema restriction. Keep specialized tables, lists and evidence fields when needed. `primary` sections show the main result; `supporting` and `debug` sections retain complete details through expansion. The raw payload is available for review.

## Commands

Replace the type without changing the publication workflow:

```bash
codex-skill-report template --type deployment-result --skill-id my-deploy-skill --report-key deploy:run-123 --status running
codex-skill-report template --type failure-analysis --skill-id analyze-failures --report-key analysis:run-123 --status succeeded
codex-skill-report template --type workflow-progress --skill-id my-workflow --report-key workflow:run-123 --status running
codex-skill-report template --type business-result --skill-id my-business-skill --report-key result:run-123 --status unknown
```

Use `--title`, `--summary`, `--command`, `--working-dir`, and `--external-attempt` to populate known fields during generation. `--output` writes the skeleton to the chosen file; otherwise JSON is written to stdout. Preserve command arguments in the private runtime report, and keep credentials and runtime files out of repository commits.

For a custom legacy type, pass its existing `--type` value: the platform retains it and uses the business-result card. For an execution with several independent reports, keep distinct report keys; for multiple files in one report, list every artifact instead of choosing only one. Do not total business reruns as though they were independent new test populations.
