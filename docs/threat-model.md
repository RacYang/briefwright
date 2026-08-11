# Threat model

## Assets

- provider credentials and quota;
- source and model-derived evidence;
- configuration and policy provenance;
- run, receipt, feedback, and experiment integrity;
- files inside the project and explicitly approved knowledge targets;
- user-level native scheduler state.

## Trust boundaries

Public feeds, release notes, URLs, XML, model output, advanced configuration, connector extensions,
existing filesystem entries, and operating-system scheduler output are untrusted. Packaged rules and
schemas, the local process, and an explicitly selected project root are trusted only for the current
installation.

## Main threats and controls

| Threat | Control |
|---|---|
| SSRF and DNS rebinding | HTTPS-only URLs, exact declared-host allowlist, post-resolution public-address checks, redirects rejected, IPv4-mapped IPv6 normalization |
| Credential exfiltration | Alibaba endpoint allowlist; typed secret references resolved after validation; values excluded from config, snapshots, errors, body, and JSON output |
| Response exhaustion | Timeouts and bounded RSS, JSON, and model response bodies; bounded capture counts and concurrency |
| Prompt injection | Source fields serialized as untrusted data; fixed system instruction; JSON Schema; domain allowlist; lexical claim-support verification; deterministic selection |
| Unsupported facts | Primary-evidence gate, explicit evidence status, hard exclusions, failure receipts, no secondary-source substitution |
| Filesystem escape | Relative output roots, realpath containment, existing symlink rejection, atomic staging, compensating restore when durable commit fails |
| Partial multi-file commit | Artifact set is staged and installed together; prior files are restored if SQLite commit fails |
| State tampering or drift | Foreign keys, immutable finalized runs, explicit checksummed migrations, configuration/rule/prompt/source digests, append-only events, replay and disk hashes |
| Unsafe automation | Manual is the default; native definition can be inspected; enable requires a matching untampered live preview and online preflight; enable/disable requires confirmation; exact prior OS state is restored if state recording fails |
| Silent policy optimization | Feedback is inert; frozen 14-day/50-item sample and feedback cutoff; full baseline/candidate selection replay; approval, activation, drift rejection, rollback; cadence proposals, hysteresis, hard bounds, human locks |
| Unapproved knowledge mutation | Proposal file, exact target/hash binding, stale-target rejection, explicit commit, project-root containment |
| Extension supply chain | Standalone CLI never imports packages from configuration; host application registers code explicitly; descriptors and contract tests required |

## Residual risk

Filesystem containment checks cannot provide kernel-level `openat` guarantees across every supported
Node platform; a hostile local process with the same account could race path components. Native
scheduler commands inherit the user's OS permissions. Model evidence verification is conservative but
not a semantic theorem prover; human review remains necessary for high-impact decisions. The
benchmark-proxy exception for DNS results in `198.18.0.0/15` is limited to already declared hosts and
is documented in the security policy.

## Release checks

- unit, integration, CLI E2E, migration, crash/resume, replay-tamper, path/symlink, SSRF, provider
  redaction, selection-boundary, governance, scheduling-definition, and package-install tests;
- production dependency audit and license inventory;
- secret-pattern scan and `git diff --check`;
- clean tarball installation and capability readback;
- macOS, Linux, and Windows CI on supported Node versions;
- optional maintainer Qwen live smoke test without credential output; user-owned provider access is
  validated locally with `doctor --online` and is not a release invariant.
