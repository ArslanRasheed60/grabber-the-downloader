# Grabber 1.0.1

- Builds from the synchronized repository history, retaining the latest open-source
  documentation, license notices, and macOS packaging changes.
- Includes Windows x64, macOS Apple Silicon, and macOS Intel installers.
- All builds run the regression/UI suite before packaging. macOS bundles also pass
  code-signature verification.
- Release publication now verifies every uploaded asset against its SHA-256 checksum.

Choose the installer for your platform. macOS ZIP archives are also included.
The macOS app installs its download tools on first launch; Windows bundles them.
See README for setup and macOS first-launch guidance.

Website authentication, regional restrictions, and DRM can still prevent downloads.
