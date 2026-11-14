# Fast queue lane (0.2.4.5)

> **0.2.4.7 update - one button, server-chosen lane.** The farmer no longer picks a
> mode per photo. `POST /api/analyze` and `POST /api/records/{id}/reanalyze` ignore
> any client `tier` field and choose the lane inside the admission transaction from
> the account's remaining daily fast allowance: up to 20 fast photos per day for a
> normal account, up to 50 for priority, unlimited for admin. Once the allowance is
> spent the photo is still accepted and runs on the paced normal pair, so a full day
> never ends in a 429 for fast capacity. `QUEUE_PACER_SECONDS` applies to the normal
> lane only; fast jobs never wait behind normal ones. Both receipts report `tier`.
> The sections below still describe the queue mechanics (lanes, worker units,
> aliases) exactly as they run.

## Model routing

The application still sends the route names configured in the admin console:

- normal mode: `GEMINI_TRIAGE_MODEL` and `GEMINI_DIAGNOSE_MODEL`, currently both `jagakebond`;
- mode Cepat: `GEMINI_TRIAGE_MODEL_FAST` and `GEMINI_DIAGNOSE_MODEL_FAST`, currently both `jagakebond-fast`.

The worker calls `models_for(job)` and sends the selected alias to 9Router. 9Router then expands that alias into its configured provider/model list. For example, `jagakebond-fast` may resolve to a flash-class model, so a router log that says `gemini-3.5-flash-lite` does not mean the app skipped the console setting. It means the router alias selected that model.

The routing chain is:

1. the photo context records `analysisTier=normal` or `analysisTier=fast`;
2. the worker claims from the matching queue lane;
3. `models_for()` selects the corresponding console aliases;
4. 9Router resolves each alias to its underlying model list;
5. the worker stores which alias it used in the job trace.

A router test that inspects model expansion should look at both the requested alias and the resolved provider/model. The admin console remains the source of the alias names.

## Queue lanes

The queue supports three claim lanes:

- `fast`: only mode Cepat jobs;
- `normal`: only normal-mode jobs;
- `all`: both, with fast jobs preferred.

The default main worker uses `WORKER_LANE=normal`. The optional `jagakebond-worker-fast.service` runs a second worker with `WORKER_LANE=fast`. This is the configuration that allows a Cepat job to start while the main worker is blocked inside a long normal-model request. A single worker cannot process two synchronous model requests at once.

The fast worker polls every two seconds when idle. The normal worker keeps the configured queue pacer (`QUEUE_PACER_SECONDS`) to protect the normal model budget.

## Deployment

Install `deploy/jagakebond-worker-fast.service` after the guarded application upgrade, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now jagakebond-worker-fast.service
sudo systemctl restart jagakebond-worker.service
```

The main unit must define `WORKER_LANE=normal`; the fast unit defines `WORKER_LANE=fast`. Both read the same protected `.env` and obtain model aliases from `/api/worker/config`, so admin-console changes apply without editing the units.

Expected service identities and logs:

```text
jagakebond-worker.service       lane: normal
jagakebond-worker-fast.service  lane: fast
```

A Cepat job should log `mode: fast` and `diagnose via jagakebond-fast`. A normal job should log `mode: normal` and `diagnose via jagakebond`.

## Safety

No API protocol, database schema, Google, DNS, signing or farmer-data behavior changes in this release. The fast worker has the same token protection, service hardening, memory limit and network policy as the main worker. Do not uninstall the Android app or clear app data when installing 0.2.4.5.
