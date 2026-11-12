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
| `executionEvidence` | Actual execution identity: background `externalAttemptId` or foreground `commandExecutionId` |
| `artifacts` | Explicit array; `[]` during running, terminal additions for later-created files |
| `relatedReportKeys` | Optional report keys for execution details folded into this stage card; display grouping only |
| `sections` | Business facts using `fields`, `list`, `table` or `json` |

The helper's default `unknown` status and draft summary are scaffolding, not results. Replace them with observed state before registration. Preparing a template outside a managed Task is supported; publication continues to use the platform's existing managed runtime contract.

## Fixed content: Card Templates v1

| Type | Primary section / columns | Metric keys, in display order |
| --- | --- | --- |
| `test-result` | `case-results`: case / outcome / detail | total, passed, failed, skipped, error, xfailed, duration |
| `deployment-result` | `targets`: target / component / version / outcome | targets, succeeded, failed, duration |
| `failure-analysis` | `findings`: case / classification / evidence / action | analyzed, confirmed, unresolved |
| `workflow-progress` | `stages`: stage / outcome / detail | stages, completed, failed |
| `business-result` | `details`: business fields | Business-defined metrics |

`--preset rerun` keeps `reportType=test-result`, with selected / passed / failed / recovered /
persistent / duration metrics. Its context identifies the original Run and selected scope.
`--preset final-summary` keeps `reportType=workflow-progress`, with cumulative_total /
cumulative_passed / cumulative_failed / final_total / final_passed / final_failed metrics and
one `final-results` table (scope / total / passed / failed / skipped / error / xfailed / xpassed / unknown).
It copies values from the actual `cumulative` and `final` objects; it does not calculate them from
failure-only reports. Counts missing from the input remain absent; a real zero stays zero.

Start/end timestamps, targets and versions in a deployment card come from actual deployment
facts. An analysis classification is a business judgment backed by its evidence row, not a
synonym for a pytest failure. Optional extra measurements remain supported.

### Metric meanings

- Test `total` covers every case outcome in this Run, including Skip and XFail; `passed`,
  `failed` and `error` remain separate. Setup/call/teardown rows of one case are not separate cases.
- Rerun `selected` is this wave's selected population; `passed` and `failed` are this Run's
  outcomes. `recovered` means previously failing cases now passing. `persistent` is the observed
  still-unresolved population; preserve Error/unknown details rather than equating it to Fail.
- Deployment `targets`, `succeeded` and `failed` count actual deployment targets and verified
  outcomes. Analysis `confirmed` counts evidence-backed issues, independently of pytest Fail.
- Workflow `stages` is the workflow's planned stage count; `completed` counts successfully
  completed stages and `failed` counts failed stages. Waiting or running stages are not completed.
- Final-summary counters use the source's `cumulative` and `final` scopes unchanged. Cumulative
  includes reruns; final replaces the earlier result for the same target/case. Totals retain
  Skip/XFail/XPass/Error/unknown rather than treating all non-Pass outcomes as Fail.

Section IDs make registration consistent but are presentation conventions, not a schema restriction. Keep specialized tables, lists and evidence fields when needed. `primary` sections show the main result; `supporting` and `debug` sections retain complete details through expansion. The raw payload is available for review.

## Result data input

Pass JSON or YAML with `--data FILE`; `--lang en` selects English field labels, otherwise labels
are Chinese. The title, summary and evidence text retain their original language.

| Input | Purpose |
| --- | --- |
| `title`, `status`, `summary` | Observed report content; explicit CLI values take precedence |
| `metrics` | Key/value measurements, or existing metric objects; fixed keys get stable labels and order |
| `rows` | Primary table rows using the keys above; case details can refer to the complete HTML |
| `fields` | Primary fields for a business-result card |
| `context`, `evidence` | Field arrays displayed as supporting details |
| `sections` | Additional business sections using the existing Schema v2 |
| `primaryExecution` | Actual command, working directory, timestamps and exit code |
| `executionEvidence` | Background `externalAttemptId` or completed foreground `commandExecutionId`; `--external-attempt` overrides it |
| `artifacts` | Explicit terminal files: `pytest-html`, standalone `failure-analysis-html`, or `failure-analysis-markdown`; running templates keep this empty |
| `relatedReportKeys` | Actual execution report keys grouped into this stage |
| `cumulative`, `final` | Final-summary counts from the platform or verified result ledger |
| `available`, `complete`, `reportCount`, `executed` | Optional final-summary provenance, retained in `count-source` |

The count alias `errors` is normalized to `error`. Additional metric keys retain their supplied
labels when metric objects are used. Duration values carry their unit (for example `60 s`).
Unknown values are omitted, not filled with zero. The helper's draft status/summary must be
replaced with observed facts before publication.

## Foreground analysis HTML

Attach the generated standalone HTML directly to the `failure-analysis` card as
`failure-analysis-html` (`.html` or `.htm`). It uses the managed archive, report-viewer and
complete-analysis entry; Markdown remains supported as `failure-analysis-markdown` (`.md`).

After the HTML-producing command has ended, query this Task's actual command audit in a later
command. Select the returned `id` of the command that wrote this file, using its command,
working directory and timestamps to identify it:

```bash
codex-skill-use codex-task-platform-api -- node \
  "$CODEX_TASK_SKILL_SNAPSHOT/codex-task-platform-api/scripts/codex_task_api.js" \
  task executions "$CODEX_TASK_ID" --limit 100
```

Put that real ID and the existing absolute file path in the result data passed to `--data`:

```json
{
  "status": "partial",
  "executionEvidence": {"commandExecutionId": "execution-actual-producing-command"},
  "artifacts": [{
    "key": "full-analysis",
    "kind": "failure-analysis-html",
    "path": "/absolute/run/failure_analysis.html"
  }]
}
```

Generate and publish through the actual analysis Skill, keeping its existing `reportKey`:

```bash
codex-skill-use analyze-failures -- codex-skill-report template \
  --type failure-analysis --report-key <analysis-key> \
  --data <run-dir>/analysis.data.json --output <run-dir>/analysis.report.json
codex-skill-use analyze-failures -- codex-skill-report publish \
  --file <run-dir>/analysis.report.json
```

The example IDs and paths are illustrative; use actual audit records and files. The file must
follow the platform's existing execution-directory ownership rules; Session mode allows the
Task-owned Session directory. Multiple input Runs do not require binding the analysis to one
pytest External Attempt: the evidence identifies the analysis file's producing command.
If publication reports missing execution evidence, find the real command ID and retry the same
logical report with that association. Keep the HTML declaration when correcting the payload;
clearing `artifacts` would publish only a card without its file. Check the publisher's `ARTIFACTS`
count and the returned report's artifact URL to distinguish publication from completed mounting.
A cross-stage summary keeps `artifacts: []` and links the analysis report with `relatedReportKeys`.

## Runnable examples

These files contain **demonstration data**, never results to publish as an actual run:

| Example | CLI selection |
| --- | --- |
| [Initial test](../examples/test-result.data.json) | `--type test-result` |
| [Rerun](../examples/rerun.data.json) | `--type test-result --preset rerun` |
| [Deployment](../examples/deployment-result.data.json) | `--type deployment-result` |
| [Analysis](../examples/failure-analysis.data.json) | `--type failure-analysis` |
| [Workflow](../examples/workflow-progress.data.json) | `--type workflow-progress` |
| [Final summary](../examples/final-summary.data.json) | `--preset final-summary` |
| [Business](../examples/business-result.data.json) | `--type business-result` |

For local preparation, replace the data path with the example's absolute path:

```bash
codex-skill-report cards
codex-skill-report template --preset final-summary --skill-id my-workflow \
  --report-key demo:summary --data <skill-dir>/examples/final-summary.data.json \
  --output /tmp/example-report.json
```

For real publication wrap the same command in `codex-skill-use <actual-business-skill> --`,
use the real observed data file and registered execution, then publish the generated file.
`template` never publishes, runs a business command or calls a model.

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

## Stage aggregates

Use `--related-reports run:group-a,run:group-b` with `template` to prepare a stage card.
Publish it through the workflow Skill, with its own stable `reportKey`, stage totals and sections.
Its `artifacts` stays empty and its `executionEvidence` stays absent: file links and execution
details come from the referenced reports without copying files or changing their ownership.
Add expected child keys to the initial stage revision and reuse the stage key at completion.
Unresolved references do not hide other reports, and ungrouped legacy cards keep their layout.

A final summary may fold in analysis details, but references to earlier *stage cards* belong in
its business sections, not `relatedReportKeys`; otherwise those stages would also fold into the
summary. Keep phase and final conclusions concise, with complete commands and diagnostics in
the expandable execution details.

## Final count source

`GET /api/sessions/:id/pytest-summary` provides cumulative and final case counts from archived
pytest reports. It keeps targets independent, folds reruns into their original cases and avoids
counting report revisions twice. `total` includes Skip and XFail; `executed` excludes Skip.
Use its response directly as final-summary data and provide the observed business conclusion.
If `available=false`, the template omits placeholder zero counters. If `complete=false`, keep that uncertainty in the status/conclusion; the template preserves the
completeness and source report count. Never infer the full Task population from its failed subset.

Source Skill updates apply to later frozen Task snapshots. Existing frozen snapshots remain unchanged.
