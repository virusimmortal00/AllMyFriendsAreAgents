# Homebrew cask

This directory holds `amfaa`'s Homebrew cask source of truth, tracking issue
[#200](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/200).

The dedicated tap is
[`virusimmortal00/homebrew-amfaa`](https://github.com/virusimmortal00/homebrew-amfaa).
See the main [README](../README.md#homebrew-macos) for the one-line install
command.

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

## How the cask stays current, end to end

- [`Casks/amfaa.rb`](Casks/amfaa.rb) in **this** repository is the source of
  truth. It is regenerated from a published release's
  `native-release-manifest.json` by
  [`scripts/update-homebrew-formula.ts`](../scripts/update-homebrew-formula.ts).
  Do not hand-edit the `version`/`url`/`sha256` fields.
- The end of **Publish accepted native release**
  (`.github/workflows/publish-native-release.yml`) runs that script against
  the manifest it just published, lints/audits the result against a
  throwaway local tap, and — if the cask actually changed — opens a pull
  request here and requests auto-merge.
  `.github/workflows/homebrew-formula.yml` runs on any PR touching
  `homebrew/Casks/amfaa.rb`: a real `brew install --cask` against the
  published artifact, then invokes the installed launcher and checks its
  reported version, before the PR can merge.
- [`virusimmortal00/homebrew-amfaa`](https://github.com/virusimmortal00/homebrew-amfaa)
  (the actual tap Homebrew users install from) mirrors this file. Its own
  `.github/workflows/sync.yml` pulls `Casks/amfaa.rb` from this repository's
  `main` branch on a schedule, lints it, commits it there when it changes,
  and then verifies the published tap installs and runs for real — using
  only that repository's own `GITHUB_TOKEN`, since reading a public file
  from this repository needs no cross-repository credential.

A broken cask never silently reaches users: it either fails to open a PR
here (lint/audit failure), opens one that never auto-merges (install/run
failure), or — if it somehow got this far — fails the tap's own sync
verification instead of getting mirrored.

## Using the cask

```sh
brew install --cask virusimmortal00/amfaa/amfaa
```

See the [tap's own README](https://github.com/virusimmortal00/homebrew-amfaa#readme)
for why this exact command (rather than `brew tap` + `brew install amfaa`) is
the one to use, upgrade/uninstall commands, and how the mirror works from
that side.

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
real `brew install --cask` runs in CI (see above) cover the rest.

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
