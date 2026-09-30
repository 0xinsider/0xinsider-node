# Releasing @0xinsider/sdk

A release is a GitHub release whose tag is `v<version in package.json>`. Publishing it runs `.github/workflows/publish.yml`, which checks drift, builds, checks the consumer example and packs the tarball in one job. A second job publishes through npm trusted publishing, with a provenance attestation. No npm publish token is stored in GitHub.

## One-time setup

Needs owner rights on the `@0xinsider` scope on npmjs.com.

1. Register the trusted publisher. Configuration needs npm 11.15.0 or later, an authenticated package owner and account-level two-factor authentication. The package must already exist; the bootstrap below handles a name that still returns 404. From the owner session:

   ```bash
   npm trust github @0xinsider/sdk --file publish.yml --repo 0xinsider/0xinsider-node --env npm --allow-publish
   ```

   Or on npmjs.com: package `@0xinsider/sdk` -> Settings -> Trusted publishers -> GitHub Actions, with organization `0xinsider`, repository `0xinsider-node`, workflow filename `publish.yml`, environment `npm`, and allowed action `npm publish`. npm does not validate the entry when you save it; a typo shows up only on a publish attempt, which is what the dry run below is for.

   For a new name, publish a separate bootstrap prerelease under the `bootstrap` tag from the authenticated owner session, with `npm publish <bootstrap-tarball> --access public --tag bootstrap`. Use a distinct version such as `0.14.0-bootstrap.0`, not the intended release version. Register the trusted publisher, publish the intended version through this workflow, then deprecate the bootstrap version and remove its tag. The bootstrap has no provenance attestation; the first default release does. Browser 2FA may be required for publication and trust registration. npm publish credentials stay out of GitHub.

   npm documents staged publishing as another way to create a new package, but the registry rejected that operation with `404 Package "@0xinsider/sdk" not found` during the September 30, 2026 bootstrap. Do not count that documented path as available without a successful registry read. The issue's publication evidence records the attempted command.

   These prerequisites are documented in [npm trust](https://docs.npmjs.com/cli/v12/commands/npm-trust/). The publish workflow itself needs npm 11.5.1 or later for OIDC; configuration uses the higher floor above.

2. Optional: in the repository settings, add required reviewers to the `npm` environment. The workflow then waits for an approval before the job that holds the publish credential starts.

3. Optional: add an `OXINSIDER_APP_READ_TOKEN` secret (read-only contents on `0xinsider/0xinsider`) so the weekly regenerate workflow can record `APP_COMMIT`. Without it the value is `null`.

## Each release

1. Bring the sources up to date. The hand-written files are authored in `0xinsider/0xinsider` under `sdk/`: from a checkout with read access, run `node scripts/sync-from-app.mjs --app <path>` (it copies them, takes the app's `sdk/package.json` version, and records the app commit in `.app-sdk-commit`), then `npm install`, `npm run generate`, `npm run check`, `npm run build`, `npm run check:examples`, and port any `sdk/README.md` change into `README.md` (`git -C <app> diff $(cat .app-sdk-commit)..origin/main -- sdk/README.md` from the previous sync shows it). `--check` exits 1 when this repository is behind.
2. Merge the change. The version comes from the app's `sdk/package.json`; regenerated types alone (`npm run generate`) usually mean a minor bump while the package is `0.x`.
3. Rehearse: Actions -> Publish to npm -> Run workflow on `main` with `dry_run` checked (the default). It runs every step, including the real OIDC token exchange, and publishes nothing. It fails if the exchange did not succeed.
4. Create a GitHub release with the tag `v<version>`. The workflow refuses a tag that does not match `package.json`, and skips a version that is already on npm.
5. Check: `npm view @0xinsider/sdk version`, and the provenance badge on https://www.npmjs.com/package/@0xinsider/sdk.

## If the publish job goes red

A red run does not prove nothing was published. [npm scans uploads before they become installable](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/), typically around five minutes, sometimes fifteen minutes or longer. This workflow waits up to fifteen minutes, which is a bound rather than a registry guarantee. A successful upload, including HTTP 202, still needs registry and consumer verification.

When the publish step succeeded but registry verification timed out, wait for that exact version to become visible before retrying. Use "Re-run failed jobs" on the same run, not a new release or dispatch. The re-run compares the registry's `dist.integrity` for the version with the tarball it holds: equal skips the publish and goes green, different stops. A genuinely absent upload can be retried from the same artifact; an accepted upload pending scanning must not be republished. Never bump the version to work around a red run.
