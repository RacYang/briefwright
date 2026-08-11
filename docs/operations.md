# Operations

## Conversational entry point

`briefwright skill install --yes` installs the packaged Codex Skill under the current user's Codex
skills directory. `skill status` is read-only. Installation and updates are content-hash managed:
an existing unrelated Skill or locally edited managed file is never overwritten. Restart Codex
after a successful install. The Skill translates ordinary-language choices into the same JSON CLI
surface used by operators; it does not own configuration, policy, or state.

The registry availability check and CLI installation are separate. Until an npm registry release is
announced, use the checksum-pinned GitHub release tarball or a source checkout; do not interpret the
presence of an npm package name in documentation as proof that it has been published.

## Run outcomes

- `success`: every due source has a successful receipt and model processing completed.
- `partial`: every due source is accounted for, but at least one source or model operation failed.
- `failed`: all useful source collection failed, required integrity failed, or the pipeline terminated.

Daily and Review files are still emitted for zero-item and partial runs. Inspect `status`, the artifact
failure section, and JSON `modelFailures` before retrying.

`run --retry-failed` creates an immutable recovery run linked to the original (`-R01`, `-R02`, and
so on). It retries only failed/skipped sources and pending model analyses, reusing validated cached
analyses after a crash. It never overwrites a finalized base run or its artifacts.

During migration, the collaborative process store may already contain today's terminal Run ID while
the new local journal does not. A formal `run` pulls the full canonical snapshot first. If the remote
run is terminal and both Daily/Review files are bound to it, Briefwright returns it as
`alreadyComplete: true` and `remoteExisting: true` without model calls, document replacement, or
duplicate synchronization. A non-terminal remote run, missing artifact, or mismatched Run ID fails
closed.

## Diagnostics

`doctor` performs offline schema, filesystem, secret-reference, and database checks. `doctor --online`
also makes a minimal model call, checks the configured process/document stores, and probes sources
that are currently due. Individual source failures are visible warnings because partial runs are a
supported terminal outcome; provider, contract, process-store, or document-store failures remain
blocking. Use `doctor --online --all-sources` for an intentional full inventory audit. It can be slow
and does not imply that every endpoint will remain reachable at run time. Doctor never creates a run,
writes a remote record, or installs a schedule.

Fixture and live previews are always written beneath `.briefwright/previews`, even when Obsidian is
the formal document store. Only `run` publishes Daily/Review and managed indexes to the configured
document destination.

## State and replay

The default database is `.briefwright/state.db`. It contains configuration snapshots, execution
plans and stages, due manifests, receipts, captures and observations, cursors, items and scores,
events, feedback, experiments, cadence proposals, knowledge proposals, artifacts, and schedule
records.

Do not edit it manually. Use `db migrate`, `status`, and `replay`. Replay is offline and validates all
artifacts recorded for a run, including current-disk tampering.

## Scheduling

Before enablement, run a live preview of the current configuration and an online doctor check. A
matching live preview must be at most seven days old and its artifact must still match the recorded
hash. Then run `schedule describe` before `schedule enable --yes`. The installer records native and
SQLite state transactionally and restores the previous native task if recording fails. `schedule
status` reports native-state drift. Config changes affect the next run; an in-progress run retains
its frozen snapshot. Disable with `schedule disable --yes` before moving a project directory or
executable.

`schedule codex` is an export, not an installer. Its prompt binds SHA-256 digests for `briefing.yaml`,
the exact built CLI, the packaged protocol, and an optional imported source contract. If X browser
capture is configured, it first emits the currently due manifest and validates the resulting
read-only bundle. A zero-source manifest requires no bundle. Any digest drift stops the task for
review instead of silently running different code or rules.

Do not point a production automation at a mutable source checkout. The export reports
`runtime.immutable: false` with a warning when the active CLI is enclosed by a Git checkout. Install
the released package into a versioned local runtime directory, invoke that exact CLI to export the
definition, and keep both the CLI and packaged protocol under that immutable prefix. Upgrades use a
new version directory and an explicit automation update; development builds cannot then break the
active task's digest.
