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

Knowledge writes are two-phase: `knowledge propose` records the exact content, target, heading, and current target hash; `knowledge commit --yes` refuses if the target changed. `open` uses an `obsidian://` URI for Obsidian projects and the system file opener for local projects.
