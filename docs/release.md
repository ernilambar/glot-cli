# Release

1. Bump `version` in `package.json` (e.g. `1.0.7` → `1.0.8`).

2. Run `bun run version` — syncs `VERSION` in `src/core/config.ts` to match `package.json` (via `easy-replace-in-files`, configured in `easy-replace.json`).

   ```bash
   bun run version
   ```

3. Add an entry for the new version at the top of `CHANGELOG.md`.

4. Run `bun run validate-changelog` — checks the changelog is well-formed (strict mode validates against the version in `package.json`).

   ```bash
   bun run validate-changelog
   ```

5. Commit the version bump.

6. Tag and push. Tags must be prefixed with `v` (e.g. `v1.0.8`) — the release workflow triggers on `v*` tags only; an unprefixed tag like `1.0.8` will not build or publish binaries.

   ```bash
   git tag v1.0.8
   git push origin v1.0.8
   ```
