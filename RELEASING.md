# Releasing @0xinsider/sdk

A release is a GitHub release whose tag is `v<version in package.json>`. Publishing it runs `.github/workflows/publish.yml`, which builds, tests and packs the tarball in one job and publishes it from a second job through npm trusted publishing, with a provenance attestation. No npm token is stored anywhere.

## One-time setup

Needs owner rights on the `@0xinsider` scope on npmjs.com.

1. Register the trusted publisher. From an npm session logged in as a scope owner (npm 11.5.1 or later):

   ```bash
   npm trust github @0xinsider/sdk --file publish.yml --repo 0xinsider/0xinsider-node --env npm --allow-publish
   ```

   Or on npmjs.com: package `@0xinsider/sdk` -> Settings -> Trusted publishers -> GitHub Actions, with organization `0xinsider`, repository `0xinsider-node`, workflow filename `publish.yml`, environment `npm`, and allowed action `npm publish`. npm does not validate the entry when you save it; a typo shows up only on a publish attempt, which is what the dry run below is for.

   If npm will not accept an entry for a package name that has never been published, publish the first version once by hand from a clean checkout of the release tag (`npm ci && npm test && npm publish --access public`), then register the trusted publisher and use the workflow from the next version on. That first version carries no provenance attestation.

2. Optional: in the repository settings, add required reviewers to the `npm` environment. The workflow then waits for an approval before the job that holds the publish credential starts.

3. Optional: add an `OXINSIDER_APP_READ_TOKEN` secret (read-only contents on `0xinsider/0xinsider`) so the weekly regenerate workflow can record `APP_COMMIT`. Without it the value is `null`.

## Each release

1. Bring the sources up to date. The hand-written files are authored in `0xinsider/0xinsider` under `sdk/`: from a checkout with read access, run `node scripts/sync-from-app.mjs --app <path>` (it copies them, takes the app's `sdk/package.json` version, and records the app commit in `.app-sdk-commit`), then `npm install`, `npm run generate`, `npm test`, and port any `sdk/README.md` change into `README.md` (`git -C <app> diff $(cat .app-sdk-commit)..origin/main -- sdk/README.md` from the previous sync shows it). `--check` exits 1 when this repository is behind.
2. Merge the change. The version comes from the app's `sdk/package.json`; regenerated types alone (`npm run generate`) usually mean a minor bump while the package is `0.x`.
3. Rehearse: Actions -> Publish to npm -> Run workflow on `main` with `dry_run` checked (the default). It runs every step, including the real OIDC token exchange, and publishes nothing. It fails if the exchange did not succeed.
4. Create a GitHub release with the tag `v<version>`. The workflow refuses a tag that does not match `package.json`, and skips a version that is already on npm.
5. Check: `npm view @0xinsider/sdk version`, and the provenance badge on https://www.npmjs.com/package/@0xinsider/sdk.

## If the publish job goes red

A red run does not prove nothing was published: the registry can lag past the three-minute verification. Use "Re-run failed jobs" on that run, not a new release or dispatch. The re-run compares the registry's `dist.integrity` for the version with the tarball it holds: equal skips the publish and goes green, absent publishes, different stops. Never bump the version to work around a red run until `npm view @0xinsider/sdk version` says it is not there.
