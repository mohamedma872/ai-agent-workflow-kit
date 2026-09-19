# Runtime versioning and releases

The runtime uses **Semantic Versioning** for the runtime implementation and separate integer compatibility versions for serialized workflow/artifact formats.

## Version sources

The authoritative metadata is `ai/runtime-version.json`:

```json
{
  "runtimeVersion": "1.1.0",
  "workflowFormatVersion": 1,
  "artifactSchemaVersion": 1,
  "releaseChannel": "stable"
}
```

`package.json` and the root package entry in `package-lock.json` must use the same runtime version/name. CI runs `npm run workflow:version:check` and rejects drift between these files, the feature workflow format, artifact schema versions, and the changelog release section.

Check the current runtime:

```bash
npm run workflow:version
npm run workflow:version:json
npm run workflow:version:check
```

Every new workflow run persists runtime/workflow/artifact versions in `state.json`. A successful GitHub verification summary publishes the same version provenance alongside the exact commit SHA.

## SemVer rules

- **PATCH** — backwards-compatible fixes, guard/eval improvements, documentation, and reliability fixes that do not change consumer contracts.
- **MINOR** — backwards-compatible runtime capabilities, additive metadata, optional stages/roles, new supported stacks or commands.
- **MAJOR** — incompatible CLI/state/workflow behavior, removed commands, migration-required defaults, or incompatible consumer contracts.

`workflowFormatVersion` and `artifactSchemaVersion` are compatibility versions, not SemVer. Bump them only when the corresponding serialized format changes incompatibly.

## Release validation

Before a release:

```bash
npm ci
npm run workflow:release:check
npm run workflow:check
npm run workflow:artifacts:check
npm run guard:selftest
npm run exam:check
```

`workflow:release:check` requires:

- synchronized runtime/package/package-lock versions;
- a matching `CHANGELOG.md` section;
- a migration document at `docs/migrations/<version>.md`;
- valid workflow and artifact compatibility metadata.

Generate release notes:

```bash
npm run workflow:release -- notes
```

Preview tag creation:

```bash
npm run workflow:release -- tag --dry-run
```

Create the annotated tag from a clean `main` checkout:

```bash
npm run workflow:release -- tag
```

Create and push it explicitly:

```bash
npm run workflow:release -- tag --push
```

Pushing `vX.Y.Z` triggers `.github/workflows/release.yml`. The workflow validates that the tag matches the authoritative runtime version, runs release/version checks, generates notes from the changelog + migration document, and creates the GitHub Release.

## Release checklist

1. Merge the intended release scope and make sure `main` CI is green.
2. Choose PATCH/MINOR/MAJOR using the rules above.
3. Update `ai/runtime-version.json`, `package.json`, and `package-lock.json` together.
4. If serialized workflow/artifact formats changed incompatibly, bump their compatibility versions and document migration steps.
5. Move release notes into a dated `CHANGELOG.md` section.
6. Add/update `docs/migrations/<version>.md`.
7. Run the release validation commands above.
8. Merge the release PR.
9. From clean `main`, create/push `vX.Y.Z` using `workflow:release`.
10. Confirm the GitHub Release workflow is green and the release notes are correct.

Never have an agent silently push a release tag or publish a release. The final `--push` is an explicit external effect and should remain human-controlled/guarded.
