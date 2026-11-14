# Deployment remediation handoff (incomplete)

Scope: `deploy/release_ops.py`, release tests, and `deploy/README.md`. No live deployment, host modification, sudo/root action, package install, or external network operation was performed.

## Changes made

- Injected an optional `runtime_path` only into lower-level transaction/staging functions for fixtures; production CLI continues to use the fixed `/opt/jagakebond-runtime/venv` policy.
- Release overlay now preserves the candidate's validated venv symlink rather than deleting it.
- `recover_publication` deliberately leaves its journal intact; CLI `recover` removes the journal only after restoring permissions, starting services, and successful version/asset readback.
- Recovery command checks journal existence before stopping services.
- Updated deploy documentation to require an administrator-prepared external `--copies` virtualenv.
- Tests now create real temporary Python venvs with `venv --copies`; recovery assertions preserve journal evidence until explicit acknowledgement.

## Verification

- `python -m unittest discover -s tests -p 'test_release_*.py' -v`: 31 tests passed on the last run (32.253s). A subsequent CLI-only recovery ordering change was syntax-checked by the patch tool, but the suite was not rerun after that final edit.
- `python -m py_compile deploy/release_ops.py`: passed before the final CLI-only edit; patch tool syntax validation passed after it.
- Independent review test script and review document specified by the task are not present in this workspace (`review/` currently only contains `OFFLINE-FINAL-FIX-HANDOFF.md`), so the independent red suite could not be rerun.

## Not accepted / remaining blockers

This is not a final approval or deployment authorization. The required C pre-stop source/AST and full required-asset inventory, installed dependency and service-user preflight, old-snapshot runtime compatibility, comprehensive multi-filesystem/candidate/restore capacity accounting, and forensic/private artifact hardening are not complete. `recover_publication` remains idempotent and intentionally non-acknowledging, but full production CLI recovery behavior has not been exercised against systemd or a real service account. Requirements compatibility is still only compared by file digest in the deploy CLI. The exact independent review acceptance suite is unavailable here.

Current `deploy/release_ops.py` SHA256: `703d12b2298766f1b35c829fd92527c06c015fb6b0dbafcaf1b21f6190e89c1f`. Verify again if the source changes.

No claim is made that the deployment tool is production-ready or that the independent A/B/C review criteria have passed.
