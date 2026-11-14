# Verification records

Frozen evidence from packaged releases. These files record what a specific package
contained at the moment it was sealed; they are **not** live state and they are not
updated after the fact.

## v0.2.4.28

| File | What it is |
| --- | --- |
| [VERIFICATION.json](v0.2.4.28/VERIFICATION.json) | Artifact checks for the packaged release: APK hash, signer certificate, versionCode, asset parity, JVM/lint results, regression counts, and the SHA-256 of every source file in the package |
| [SOURCE-SHA256.json](v0.2.4.28/SOURCE-SHA256.json) | Source manifest written into the delivered source ZIP |

Reading them:

- `production_deployed`, `physical_device_validated` and
  `expert_diagnostic_benchmark_completed` are the honest boundary flags of that package.
  A `false` there is not an oversight; it marks a claim the package does not make.
- The file hashes describe the tree as packaged for 0.2.4.28. Any later commit — including
  the documentation reorganisation that moved these notes into `docs/` — changes those
  hashes. Use git tag `v0.2.4.28` to recover the exact released tree.
- Live deployment readback lives in [../operations/deployment.md](../operations/deployment.md).