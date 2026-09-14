# Homebrew formula

This directory holds the Homebrew formula for `amfaa`, tracking issue
[#200](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/200).

## Current state: in-repo formula, no dedicated tap yet

The plan in issue #200 calls for a separate `virusimmortal00/homebrew-amfaa`
tap repository, which is the location Homebrew's naming convention (and
`brew tap`) expects for a formula named `amfaa`. Creating that repository
requires GitHub repo-creation permissions this change does not have, so as an
interim step the formula lives here instead:

- [`Formula/amfaa.rb`](Formula/amfaa.rb) is the **source of truth** for the
  formula until a dedicated tap repository exists. Do not fork or duplicate
  it elsewhere without updating this note.
- It is regenerated from a published release's `native-release-manifest.json`
  by [`scripts/update-homebrew-formula.ts`](../scripts/update-homebrew-formula.ts)
  (see below). Do not hand-edit the `url`/`sha256` fields.

### Follow-up: move this to a real tap

Once `virusimmortal00/homebrew-amfaa` (or an equivalent tap repository) can be
created:

1. Copy `Formula/amfaa.rb` from this repo into `Formula/amfaa.rb` in the new
   tap repository.
2. Point `scripts/update-homebrew-formula.ts`'s output path (or the workflow
   step that invokes it, see below) at a checkout of that repository instead
   of `homebrew/Formula/amfaa.rb` in this repo.
3. Update this README and `docs/operations/native-releases.md` to describe
   `brew tap virusimmortal00/amfaa` instead of the manual steps below.
4. Leave this `homebrew/` directory in place for one release cycle with a
   note pointing at the new tap, then remove it.

## Using the formula today

Homebrew requires a formula to live in a tap (a git repository Homebrew
knows how to find formulae in). Until the dedicated tap above exists, use
this repository itself as the tap:

```sh
brew tap virusimmortal00/all-my-friends-are-agents https://github.com/virusimmortal00/AllMyFriendsAreAgents
brew install virusimmortal00/all-my-friends-are-agents/amfaa
```

Homebrew looks for formulae directly under `Formula/` at the tap's root, not
under a `homebrew/` subdirectory, so tapping this repository as-is will not
find `amfaa.rb` where Homebrew expects it. Until the formula is relocated to
match that layout (or into a dedicated tap, see above), install it directly
from the formula file in a checkout instead:

```sh
git clone https://github.com/virusimmortal00/AllMyFriendsAreAgents
brew install --formula AllMyFriendsAreAgents/homebrew/Formula/amfaa.rb
```

Upgrading and uninstalling then follow normal Homebrew lifecycle commands
(`brew upgrade amfaa`, `brew uninstall amfaa`) once installed by formula name.

This is deliberately separate from `scripts/install-native.sh`'s own
`update`/`rollback`/`uninstall` subcommands (see
[`docs/operations/native-releases.md`](../docs/operations/native-releases.md)).
Homebrew replaces the whole install directory on `brew upgrade`, so the
tarball's internal `versions/`/rollback bookkeeping is redundant under
Homebrew -- "rollback" there is just `brew install amfaa@<previous-version>`
or reinstalling the previous formula revision. The formula does not try to
reuse that machinery.

## Regenerating the formula

`scripts/update-homebrew-formula.ts` takes a published release's
`native-release-manifest.json` and (re)writes `Formula/amfaa.rb` with that
release's version and the `darwin-arm64`/`darwin-x64` artifact URLs and
SHA-256 digests:

```sh
curl -fsSL -o /tmp/native-release-manifest.json \
  https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v<version>/native-release-manifest.json
pnpm tsx scripts/update-homebrew-formula.ts /tmp/native-release-manifest.json
```

The script only reads the manifest's `application.version`/`commit` and the
two darwin targets' `artifact` entries; it does not re-verify SBOM or
provenance the way `scripts/install-native.sh` does; Homebrew's own
`url`/`sha256` verification on download already covers artifact integrity,
so the formula does not need to reimplement the installer's SLSA
provenance-subject binding.

## Follow-up: wire this into release promotion

Bumping the formula is currently a manual step. A natural follow-up (left
out of this change since the publish workflow is sensitive and gated, see
`docs/operations/native-releases.md`) is to add a step at the end of
**Publish accepted native release** that runs this script against the
manifest it just published and commits the result -- to this path while it
remains the source of truth, or to the dedicated tap repository once that
exists.
