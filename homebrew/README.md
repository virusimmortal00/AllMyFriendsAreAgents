# Homebrew cask

This directory holds the Homebrew cask for `amfaa`, tracking issue
[#200](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/200).

## Why a cask, not a formula

This started as a Formula. Real `brew install` testing caught that every
from-source Formula install runs Homebrew's Mach-O linkage-fixing pass
unconditionally, and that pass fails on the published archive: it is a fully
self-contained bundle (its own pinned Node.js runtime, the audited OpenCode
runtime, and a full production `node_modules` tree), and rewriting the
bundled `@rollup/rollup-darwin-arm64` native addon's dylib ID to this
bundle's deeply nested install path overflows that addon's Mach-O header
padding. Homebrew Casks stage files as-is with no relinking, which sidesteps
the problem generally rather than patching around this one binary.

## Current state: in-repo cask, no dedicated tap yet, automated on release

The plan in issue #200 calls for a separate `virusimmortal00/homebrew-amfaa`
tap repository, which is the location Homebrew's naming convention (and
`brew tap`) expects for a cask named `amfaa`. Creating that repository
requires GitHub repo-creation permissions this change does not have, so as an
interim step the cask lives here instead:

- [`Casks/amfaa.rb`](Casks/amfaa.rb) is the **source of truth** for the cask
  until a dedicated tap repository exists. Do not fork or duplicate it
  elsewhere without updating this note.
- It is regenerated from a published release's `native-release-manifest.json`
  by [`scripts/update-homebrew-formula.ts`](../scripts/update-homebrew-formula.ts).
  Do not hand-edit the `version`/`url`/`sha256` fields.
- **This is wired into the release pipeline.** The end of **Publish accepted
  native release** (`.github/workflows/publish-native-release.yml`) runs that
  script against the manifest it just published, lints/audits the result
  against a throwaway local tap, and — if the cask actually changed — opens a
  pull request with auto-merge requested. `.github/workflows/homebrew-formula.yml`
  runs on that PR (and on any other PR touching `Casks/amfaa.rb`): a real
  `brew install --cask` against the published artifact, then invokes the
  installed launcher and checks its reported version, before the PR can
  merge. A release with a broken cask never gets to merge a stale-looking
  bump silently — the PR simply doesn't open, or its check fails and it
  never auto-merges.

### Follow-up: move this to a real tap

Once `virusimmortal00/homebrew-amfaa` (or an equivalent tap repository) can be
created:

1. Copy `Casks/amfaa.rb` from this repo into `Casks/amfaa.rb` in the new tap
   repository.
2. Point `scripts/update-homebrew-formula.ts`'s output path (or the workflow
   step that invokes it) at a checkout of that repository instead of
   `homebrew/Casks/amfaa.rb` in this repo.
3. Update this README and `docs/operations/native-releases.md` to describe
   `brew tap virusimmortal00/amfaa` instead of the manual steps below.
4. Leave this `homebrew/` directory in place for one release cycle with a
   note pointing at the new tap, then remove it.

## Using the cask today

Homebrew requires a cask to live in a tap (a git repository Homebrew knows
how to find casks in). Until the dedicated tap above exists, use this
repository itself as the tap:

```sh
brew tap virusimmortal00/all-my-friends-are-agents https://github.com/virusimmortal00/AllMyFriendsAreAgents
brew install virusimmortal00/all-my-friends-are-agents/amfaa
```

Homebrew looks for casks directly under `Casks/` at the tap's root, not under
a `homebrew/` subdirectory, so tapping this repository as-is will not find
`amfaa.rb` where Homebrew expects it. Until the cask is relocated to match
that layout (or into a dedicated tap, see above), stage it into a local tap
instead:

```sh
git clone https://github.com/virusimmortal00/AllMyFriendsAreAgents
brew tap-new local/amfaa --no-git
mkdir -p "$(brew --repository local/amfaa)/Casks"
cp AllMyFriendsAreAgents/homebrew/Casks/amfaa.rb "$(brew --repository local/amfaa)/Casks/amfaa.rb"
brew install --cask local/amfaa/amfaa
```

Upgrading and uninstalling then follow normal Homebrew lifecycle commands
(`brew upgrade --cask amfaa`, `brew uninstall --cask amfaa`) once installed.

This is deliberately separate from `scripts/install-native.sh`'s own
`update`/`rollback`/`uninstall` subcommands (see
[`docs/operations/native-releases.md`](../docs/operations/native-releases.md)).
Homebrew replaces the whole install directory on `brew upgrade`, so the
tarball's internal `versions/`/rollback bookkeeping is redundant under
Homebrew -- "rollback" there is just reinstalling the previous cask revision.
The cask does not try to reuse that machinery.

## Regenerating the cask by hand

`scripts/update-homebrew-formula.ts` takes a published release's
`native-release-manifest.json` and (re)writes `Casks/amfaa.rb` with that
release's version and the `darwin-arm64`/`darwin-x64` artifact SHA-256
digests (the download URL is derived from the version and Homebrew's `arch`
value, verified at generation time against the manifest's actual artifact
URLs so a naming-convention mismatch fails loudly instead of silently
generating a cask that points at the wrong bytes):

```sh
curl -fsSL -o /tmp/native-release-manifest.json \
  https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v<version>/native-release-manifest.json
pnpm tsx scripts/update-homebrew-formula.ts /tmp/native-release-manifest.json
```

The script only reads the manifest's `application.version`/`commit` and the
two darwin targets' `artifact` entries; it does not re-verify SBOM or
provenance the way `scripts/install-native.sh` does. Homebrew's own
`sha256` verification on download already covers artifact integrity, and the
real `brew install --cask` run in CI (see above) covers the rest.

Validate a hand-edited or regenerated cask the same way CI does, before
committing it:

```sh
brew tap-new local/amfaa --no-git
mkdir -p "$(brew --repository local/amfaa)/Casks"
cp homebrew/Casks/amfaa.rb "$(brew --repository local/amfaa)/Casks/amfaa.rb"
brew style local/amfaa/amfaa
brew audit --cask local/amfaa/amfaa
brew install --cask local/amfaa/amfaa
"$(brew --prefix)/bin/amfaa" version
```
