# Documentation

Everything written down about JagaKebond, apart from the code-adjacent handoffs that
live next to the code they describe.

## Start here

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Components, data flow, AI pipeline, evidence limits |
| [design.md](design.md) | Interface direction, tokens, layout states, content boundaries |
| [ai-evaluation.md](ai-evaluation.md) | What would be required to claim diagnostic accuracy |
| [operations/deployment.md](operations/deployment.md) | Production layout, release, rollback, backup |
| [releases/](releases/) | Release-note archive, 0.2.2.0 → 0.2.4.19 |
| [records/v0.2.4.28/](records/v0.2.4.28/) | Frozen verification record for the released 0.2.4.28 package |

## Build and test

| Document | What it covers |
| --- | --- |
| [../BUILD.md](../BUILD.md) | Ordered build, Android build and packaging commands |
| [../app/README.md](../app/README.md) | Application-level development notes |
| [../app/PRD.md](../app/PRD.md) | Product requirements, reconstructed from the live MVP |
| [../app/BUILD-INSTRUCTIONS.md](../app/BUILD-INSTRUCTIONS.md) | Building the original MVP from zero |
| [../app/QUEUE_SETUP.md](../app/QUEUE_SETUP.md) | Queue states, worker and n8n setup |

## Code-adjacent handoffs

These stay beside the code they describe rather than in this tree:

| Document | Location |
| --- | --- |
| Android client | [../android-client/ANDROID-HANDOFF.md](../android-client/ANDROID-HANDOFF.md) |
| Deployment runbook | [../app/deploy/RELEASE-RUNBOOK.md](../app/deploy/RELEASE-RUNBOOK.md) |
| Application overview | [../app/handoff.md](../app/handoff.md) |
| Backend hardening | [../app/HARDENING-HANDOFF.md](../app/HARDENING-HANDOFF.md) |
| Offline frontend | [../app/OFFLINE-FRONTEND-HANDOFF.md](../app/OFFLINE-FRONTEND-HANDOFF.md) |

## Conventions for new documents

- Release notes go in `releases/` as `v<version>-<slug>.md`, one file per change set,
  starting with an `# ` title and a `> **Release** x.y.z · **Status** …` line.
- Register every new note in [releases/README.md](releases/README.md) and add a
  `CHANGELOG.md` entry at the repository root.
- Explain the decision and its validation boundary. State plainly what was *not*
  verified — deployment, phone acceptance and diagnostic accuracy are separate claims.
- Relative links only; no absolute machine paths, hostnames with credentials, or
  operator-specific locations outside the operations documents.
- No secrets, tokens, database dumps or farmer photos, ever.