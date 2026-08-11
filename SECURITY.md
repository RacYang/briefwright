# Security policy

Briefwright processes untrusted public content and model output. Review the deployment's source,
provider, filesystem, and native scheduling permissions before production use.

## Reporting

Please report suspected vulnerabilities privately through GitHub Security Advisories for `RacYang/briefwright`. Do not open a public issue containing credentials, private source content, or exploit details.

## Security model

- Source connectors are read-only.
- Default demo and fixture preview require no credential.
- Output and state paths are bounded to a project root; symlinked components are rejected before writes.
- Formal Qwen runs resolve a typed secret reference from the process environment, an ignored
  `.env.local`, or an explicitly configured bounded file. Values are excluded from configuration,
  hashes, snapshots, diagnostics, and errors.
- Redirects are rejected by the built-in HTTP client.
- Literal and DNS-resolved non-public connector targets are rejected at connection time. Network reads are restricted to hosts declared by the active packaged preset.
- Response bodies are bounded before parsing.
- Prompt source fields are serialized as untrusted data. Model output must satisfy a JSON Schema and
  claim-support check before deterministic selection.
- Native schedules and knowledge writes require explicit command confirmation. Knowledge commits
  are bound to the target hash observed during proposal preview.

On systems using a transparent proxy with the RFC 2544 benchmarking range, addresses in `198.18.0.0/15` are accepted only while connecting to an exact host declared by the effective, validated source configuration. Literal benchmark addresses remain rejected.

## Supported provider endpoints

Qwen credentials are sent only to an allowlist of Alibaba Model Studio pay-as-you-go shared,
workspace-specific, or trial OpenAI-compatible HTTPS hosts. Coding Plan and Token Plan endpoints are
rejected because they are intended for interactive coding tools, not recurring backend jobs. Expert
configuration cannot redirect an authorization header to an arbitrary host or path.

## Residual boundaries

The `198.18.0.0/15` exception exists only for DNS results reached through an exact host already declared by
the effective source configuration, to support transparent local benchmarking proxies. Literal addresses remain
rejected. Native scheduler installation changes user-level operating-system state and should be
reviewed with `schedule describe` first.
