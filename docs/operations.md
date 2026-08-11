# Operations

## Run outcomes

- `success`: every due source has a successful receipt and model processing completed.
- `partial`: every due source is accounted for, but at least one source or model operation failed.
- `failed`: all useful source collection failed, required integrity failed, or the pipeline terminated.

Daily and Review files are still emitted for zero-item and partial runs. Inspect `status`, the artifact
failure section, and JSON `modelFailures` before retrying.

## Diagnostics

`doctor` performs offline schema, filesystem, secret-reference, and database checks. `doctor --online`
also makes a minimal model call and checks each connector. It does not create a run or install a
schedule.

## State and replay

The default database is `.briefwright/state.db`. It contains configuration snapshots, execution
plans and stages, due manifests, receipts, captures and observations, cursors, items and scores,
events, feedback, experiments, cadence proposals, knowledge proposals, artifacts, and schedule
records.

Do not edit it manually. Use `db migrate`, `status`, and `replay`. Replay is offline and validates all
artifacts recorded for a run, including current-disk tampering.

## Scheduling

Always run `schedule describe` before `schedule enable --yes`. Config changes affect the next run;
an in-progress run retains its frozen snapshot. Disable with `schedule disable --yes` before moving a
project directory or executable.
