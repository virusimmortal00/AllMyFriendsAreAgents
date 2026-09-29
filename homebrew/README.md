# Homebrew distribution paused

The Homebrew cask has been removed. The published v0.1.1 macOS archives contain
an OpenCode executable whose code signature fails verification, and an ad-hoc
signature does not provide Gatekeeper trust for Homebrew downloads.

The native shell installer remains available from the main
[README](../README.md). To restore Homebrew distribution, sign all bundled
macOS executable code with a Developer ID Application certificate, notarize the
release, verify a quarantined installation on both Apple Silicon and Intel,
then restore the cask and its tap sync workflow.
