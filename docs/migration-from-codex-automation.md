# Migrating an existing Codex automation

This path preserves an existing source registry, process history, rule identity, Obsidian layout,
failure accounting, and independent-task schedule. It does not ask operators to recreate them by
hand and it does not write to the production Base or vault during discovery.

## 1. Capture the existing boundary

Read the current automation definition and its bound execution contract. Record the schedule,
notification policy, model/reasoning choice, working directory, contract path and SHA-256, Lark Base
token and nine table mappings, Obsidian root, active Rule IDs, and X capture lane. Never copy secret
values into the project or Git.

Create a version 3 `briefing.yaml` in a dedicated local deployment directory. Select the provider,
process store, document store, and schedule explicitly. Use `sourceContract.path` plus
`sourceContract.sha256` to keep the original full contract as a fail-closed input.

## 2. Import without mutating production

```bash
briefwright --json config validate --config /path/to/briefing.yaml
briefwright --json import contract /path/to/ai-intelligence-contract.json --config /path/to/briefing.yaml
briefwright --json import lark --config /path/to/briefing.yaml
```

Contract import creates a content-addressed snapshot. Lark import paginates and validates all nine
tables, resolves relationships through stable business IDs, and imports history into the local
evaluator. Neither command changes Base records, schemas, the source contract, or Obsidian.

## 3. Prove both safe paths

Run production-bound diagnostics and a local live preview:

```bash
briefwright --json doctor --online --config /path/to/briefing.yaml
briefwright --json capture manifest --config /path/to/briefing.yaml
briefwright --json preview --live --config /path/to/briefing.yaml
briefwright --json preview --live --editorial --config /path/to/briefing.yaml
```

Online doctor probes only currently due sources by default. Use `--all-sources` only for a deliberate
inventory audit. The first preview proves source connectivity; the editorial shadow calls the configured
real model on a bounded, diversified sample and applies the formal evidence and selection gates. Preview
artifacts always remain under the deployment's `.briefwright/previews` and never overwrite the production
vault or write Feishu.

Then copy the configuration into an isolated shadow project with SQLite and a local document folder,
enable one representative source, and perform a real formal run with the chosen model. Require one
receipt per due source, a terminal outcome, both Daily and Review artifacts, complete Rule IDs,
integrity success, and an exact offline `replay` match. This is the write-path proof without touching
the production Base or vault.

## 4. Export and replace the task

Use a released package installed in a versioned local runtime directory for production. Do not
export from a mutable source checkout: `schedule codex` reports `runtime.immutable: false` when it
detects that boundary. Keeping the executable and packaged protocol under the same versioned prefix
lets development continue without changing the active task digest.

```bash
briefwright --json schedule codex --config /path/to/briefing.yaml
```

The exported independent-task prompt includes absolute Node and CLI paths and SHA-256 digests for the
configuration file, effective configuration (including packaged prompt/policy/provider/preset), exact
CLI build, packaged execution protocol, and bound source contract. The task always checks the
external-capture manifest. It creates and validates a bundle only when a due source explicitly uses
the Codex browser or Computer Use bridge; the latter is constrained to the manifest's entry URL,
exact allowed hosts, and public read-only interaction policy. It then runs online doctor and the
formal pipeline and returns only the bounded completion report.

Incident replay may use `preview --live --editorial --capture-bundle BUNDLE --bundle-only` to prevent
unrelated due sources from entering the shadow. A bundle-only preview is diagnostic evidence only and
cannot satisfy the schedule enablement gate.

Update the existing automation in place so its identity, daily schedule, notification policy, model,
reasoning effort, and execution environment remain unchanged. Replace only its prompt with the
exported definition. Read the saved automation back and compare every field and digest. Do not keep a
second active task.

## 5. First-run and rollback policy

Do not manually run the production formal command merely to test cutover if the current day's old task
has already finalized its run; that could replace same-day human documents with a different due
snapshot. The isolated shadow run plus production doctor/import/editorial shadow are the pre-cutover
proof. Observe the first normal scheduled run and verify its completion report, Lark run/receipt
records, Daily/Review artifacts, managed indexes, and replay hashes.

If a same-day terminal run already exists in the process store during cutover, adoption is allowed
only when it is explicitly `published`, its linked receipts exactly cover the independently frozen
due-source manifest, and both local documents match the remotely committed byte digests. Legacy
terminal records without these fields fail closed and require explicit migration or a recovery run.
A non-terminal remote run fails closed to prevent concurrent writers.

Rollback is operationally small: restore the previous automation prompt while keeping the same task
ID and schedule. Imported snapshots and the Briefwright local state are append-only evidence; they do
not require deleting production data.
