# Configuration

## Ordinary users

`briefing.yaml` expresses intent: name, interests, preset, schedule, output directory, and AI provider.
Missing optional values receive documented defaults. Unknown values are errors.

The precedence order is:

1. packaged schema and connector defaults;
2. packaged preset, policy, prompt, and provider resources;
3. `briefing.yaml` intent;
4. explicitly ejected resources in `briefwright.d/`;
5. an approved experiment policy in local state;
6. explicit command flags for the current operation.

Secrets do not participate in merging. A provider stores only a typed `env` or `file` reference; the
value is resolved after validation and never enters configuration hashes, snapshots, JSON output, or
errors.

## Explain and compare

```bash
briefwright config validate
briefwright config render
briefwright config explain provider
briefwright config diff --against ../other/briefing.yaml
```

`render` contains secret references, not values. `explain` reports the winning origin.

## Migration

Intent and database migrations are separate:

```bash
briefwright config migrate                 # preview only
briefwright config migrate --write         # backup and atomic write
briefwright db migrate                      # status only
briefwright db migrate --write              # backup and transactional migrations
```

Unknown future versions and lossy downgrades fail. Scheduled runs never rewrite configuration.

## Expert resources

`config eject --yes` creates typed resources with the envelope:

```yaml
apiVersion: briefwright.dev/v1alpha1
kind: Profile
metadata:
  id: local
spec: {}
```

The generated profile is the right place to select a workspace-specific Qwen endpoint or model.
Policy changes should normally use the experiment lifecycle rather than direct editing.
