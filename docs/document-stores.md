# Document stores

`local` and `obsidian` implement the same filesystem-backed document contract. Both use atomic writes, canonical path checks, symlink escape rejection, managed indexes, replay, and the human knowledge gateway.

```yaml
documentStore: local
outputDirectory: briefs
```

```yaml
documentStore:
  driver: obsidian
  root: /absolute/path/to/My Vault
  briefingDirectory: Inbox/AI Intelligence
```

An explicit Obsidian root is the user's filesystem authorization boundary. Automatic runs write only Daily, Review, and their two indexes beneath the briefing directory. They do not create or modify evergreen Notes or Refs.

Knowledge intake is a source-bound gateway:

1. `knowledge resolve` reads one exact published Daily or Review item and returns a selection digest without writing.
2. `knowledge select --yes --expect-selection <digest>` records the user's exact article selection as a `knowledge-selection-receipt`. It is stored and reported separately from generic feedback such as `knowledge-worthy`; neither can substitute for the other, and overlapping positive signals still count as one effective positive item.
3. `knowledge propose <selection-id> --request-id <uuid-v4> --target <path>` scans every ordinary Markdown note below the document root without following symlinks. It excludes only the configured briefing subtree, `.briefwright`, `briefwright.d`, `.obsidian`, `.trash`, and writer staging files; Archive remains in scope. The command infers `merge` for an existing target and `create` only for an absent target. It binds the zero-match vault scan, source and capture identity, target-before and target-after hashes, bounded diff, proposal digest, expected post-install scan, and exactly one target write. Duplicate, conflicting, multiple, unsafe, or unreadable paths return `HOLD` without a committable proposal. The request ID is client-generated once and preserved across retries: the same request, selection, target, and heading return the existing proposal readback with zero writes, while a conflicting reuse fails closed.
4. `knowledge commit <proposal-id> --yes --expect-digest <digest> --expect-writes 1` repeats the source scan immediately before install, makes the actual target preimage hash part of the production writer, and uses a no-clobber install. It then rereads the exact bytes, verifies the only source match is the reviewed target, and only then stores a matching commit receipt. A stale target, competing file, new duplicate, missing confirmation, digest mismatch, count mismatch, or byte mismatch fails closed. Normal failures restore the original without staging residue; if a competing edit makes automatic restoration unsafe, the competing target and an explicitly reported adjacent backup are both retained for recovery. Cleanup failure after a durable receipt is reported as a successful commit with `cleanupWarnings`, never as a retryable commit failure.

`knowledge readback` accepts exactly one request ID or proposal ID and performs no writes. It verifies the durable selection and proposal binding, the exact preview bytes, the current target preimage or committed content, and any commit receipt. It returns the stored operation, bounded diff, expected target hash, resulting content hash, proposal digest, vault-scan digest, and expected post-scan digest so a lost initial response never removes the material the user must review. Run it after every new `PROPOSED` response, not only after an error; proposal review and commit confirmation may begin only from a matching readback. It reports selection confirmation and commit confirmation as separate phases. This is the recovery authority after a lost response, task handoff, or context compression; conversation summaries are only caches.

Resolving and proposing do not create the evergreen target or its target directories. Selection and proposal creation write only Briefwright's local process state and verified preview under `.briefwright`; commit is the sole evergreen knowledge-target write path. `open` uses an `obsidian://` URI for Obsidian projects and the system file opener for local projects.

Stable vault reads bind ancestor and file identities before and after directory enumeration or file-handle reads, and reject persistent replacements, symlinks below the configured root, changed file metadata, and path escapes. Pure Node.js cannot provide a cross-platform, descriptor-relative atomic walk, so an actively adversarial same-identity ABA swap remains an explicit residual risk; any detected uncertainty is `HOLD`, never a successful scan.
