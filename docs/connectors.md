# Connector contract

Every connector publishes a typed descriptor containing identity, semantic version, configuration
schema, capabilities, authentication needs, examples, owner, and risk labels. It implements:

- offline configuration validation;
- online connection check;
- bounded capture returning canonical URLs, stable external keys, content hashes, timestamps, and
  evidence class;
- conditional fetch metadata where the protocol supports it.

Connectors are read-only. They cannot score, select, persist state, render output, resolve unrelated
secrets, or add undeclared hosts. Redirects, private/loopback/link-local addresses, DNS rebinding,
oversized responses, and unbounded excerpts are rejected by the core network boundary.

Built-in connectors are RSS/Atom, GitHub Releases, bounded webpages, the official X API, the
source-bound X browser bridge, the isolated in-app Browser bridge, and the source-bound Computer Use bridge. Contributions require
connector contract tests, fixtures, response bounds, and explicit risk labels.

The in-app Browser bridge is the default for public dynamic websites that cannot be captured through
bounded HTTP. It must run in the Codex-isolated browser surface and must not take over Chrome, the
user's foreground tab, or another desktop app. Its bundle declares `captureMode: in-app-browser`, a
clean HTTPS entry URL, and exact allowed hosts.

Computer Use is reserved for sources that truly require local App/UI operation; it is not the default
web browser and not a model permission. The manifest freezes a clean
HTTPS entry URL and exact allowed hosts. The operator may only read public visible content; login,
typing, downloads, interactions, settings changes, and private content are forbidden. The resulting
bundle is accepted only when it is current, declares `captureMode: computer-use`, remains on an
allowed host, and passes the same evidence and publication gates as every other capture. A Computer
Use capture that includes `publishedAt` must also declare `dateKind: event` or
`dateKind: page-updated`. Only `event` becomes the event publication timestamp used by freshness
gates; `page-updated` is retained as page-edit metadata and never makes an event recent.

For an isolated historical or incident regression, use
`preview --live --editorial --capture-bundle BUNDLE --bundle-only`. That mode processes only sources
listed in the supplied bundle and never fetches other configured sources. It is deliberately excluded
from schedule-readiness evidence because it does not exercise the complete currently due manifest.

## SDK

The package exports `defineConnector`, `registerConnector`, and `verifyConnectorContract` from
`briefwright/connector-sdk`. Embedded applications may register an `extension` adapter before
calling the runtime. Extension source configuration must declare `options.allowedHosts`; the core
HTTP client still enforces HTTPS, public DNS results, redirects, timeouts, and response limits.

The standalone CLI does not auto-import arbitrary packages or execute configuration as code. A host
application owns package installation and registration, keeping the default CLI supply-chain surface
closed.
