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

Built-in connectors are RSS/Atom and GitHub Releases. Contributions require connector contract tests,
fixtures, response bounds, and explicit risk labels.

## SDK

The package exports `defineConnector`, `registerConnector`, and `verifyConnectorContract` from
`briefwright/connector-sdk`. Embedded applications may register an `extension` adapter before
calling the runtime. Extension source configuration must declare `options.allowedHosts`; the core
HTTP client still enforces HTTPS, public DNS results, redirects, timeouts, and response limits.

The standalone CLI does not auto-import arbitrary packages or execute configuration as code. A host
application owns package installation and registration, keeping the default CLI supply-chain surface
closed.
