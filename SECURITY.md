# Security policy

Briefwright is pre-release software. Do not use it for sensitive or production workloads without reviewing its network, filesystem, connector, and scheduling boundaries.

## Reporting

Please report suspected vulnerabilities privately through GitHub Security Advisories for `RacYang/briefwright`. Do not open a public issue containing credentials, private source content, or exploit details.

## Security model

- Source connectors are read-only.
- Default demo and fixture preview require no credential.
- Output and state paths are bounded to a project root; symlinked components are rejected before writes.
- The current bundled preset requires no secrets. Typed secret references are part of the accepted design but are not implemented yet.
- Redirects are rejected by the built-in HTTP client.
- Literal and DNS-resolved non-public connector targets are rejected at connection time. Network reads are restricted to hosts declared by the active packaged preset.
- Response bodies are bounded before parsing.
- Schedules, external destinations, plugins, publication, and knowledge writes require separate confirmation boundaries.

On systems using a transparent proxy with the RFC 2544 benchmarking range, addresses in `198.18.0.0/15` are accepted only while connecting to a host declared by the active packaged preset. Arbitrary user-provided connector hosts are not supported in this pre-release.

This model will expand before the first stable release with connector permission manifests, dependency provenance, and release signing.
