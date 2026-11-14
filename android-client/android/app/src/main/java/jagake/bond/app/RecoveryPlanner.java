package jagake.bond.app;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Runs when an account is activated, when the app starts and after a sign-in (audit H-1 and the explicit "Sinkronkan").
 * It repairs rows that would otherwise wait forever and says which drafts need a queued attempt:
 * <ul>
 *   <li>{@code uploading} with no active or queued work (the work was cancelled by a logout, or the process died after the
 *       work finished) goes back to {@code pending} and is queued. The server replays by clientRequestId, so a repeat is safe.</li>
 *   <li>{@code pending} waiting out a network or server back-off is released now; a wait the server asked for
 *       (429 / 503 Retry-After) is honoured.</li>
 *   <li>{@code blocked} for a recoverable reason is queued; {@code failed} for a network/server-side reason is revived.</li>
 * </ul>
 */
final class RecoveryPlanner {
    enum State { NONE, WAITING, RUNNING }

    interface WorkProbe {
        /** @return draft id to the state of its queued upload work; ids without work are absent. May throw when unknown. */
        Map<String, State> snapshot(String account) throws Exception;
    }

    static final class Plan {
        final String id;
        final long delayMs;
        /** Replace an already queued (delayed) attempt instead of keeping it. */
        final boolean replace;

        Plan(String id, long delayMs, boolean replace) {
            this.id = id;
            this.delayMs = delayMs;
            this.replace = replace;
        }
    }

    private RecoveryPlanner() { }

    static boolean isServerWait(String error) {
        return "rate_limited".equals(error) || "server_busy".equals(error);
    }

    static List<Plan> run(OutboxStore store, String account, WorkProbe probe, final long now) throws Exception {
        Map<String, State> snapshot;
        try {
            snapshot = probe.snapshot(account);
        } catch (Exception unknown) {
            snapshot = null;
        }
        final Map<String, State> states = snapshot;
        final List<Plan> plans = new ArrayList<>();
        store.edit(account, new OutboxStore.RowsEdit() {
            @Override public boolean apply(List<JSONObject> rows) throws Exception {
                boolean changed = false;
                for (JSONObject row : rows) {
                    String id = row.optString("clientRequestId");
                    String status = row.optString("status", "pending");
                    String error = UploadEngine.errorOf(row);
                    State state = states == null ? null : (states.containsKey(id) ? states.get(id) : State.NONE);
                    if ("uploading".equals(status)) {
                        if (state == State.NONE) {
                            row.put("status", "pending");
                            changed = true;
                            plans.add(new Plan(id, 0, false));
                        }
                    } else if ("pending".equals(status)) {
                        long next = row.optLong("nextAttemptAtMs", 0);
                        long delay = 0;
                        boolean replace = false;
                        if (next > now && isServerWait(error)) {
                            delay = next - now;
                        } else if (next > now) {
                            row.remove("nextAttemptAtMs");
                            changed = true;
                            replace = state == State.WAITING;
                        }
                        if (state == State.RUNNING) continue;
                        if (state == State.WAITING && !replace) continue;
                        plans.add(new Plan(id, delay, replace));
                    } else if ("blocked".equals(status)) {
                        if (SyncStatusPolicy.retryOnExplicitSync(status, error) && state != State.RUNNING && state != State.WAITING) {
                            plans.add(new Plan(id, 0, false));
                        }
                    } else if ("failed".equals(status)) {
                        if (SyncStatusPolicy.revivesOnExplicitSync(status, error)) {
                            row.put("status", "pending");
                            row.remove("error");
                            row.remove("nextAttemptAtMs");
                            UploadPolicy.clearCounters(row);
                            changed = true;
                            if (state != State.RUNNING && state != State.WAITING) plans.add(new Plan(id, 0, false));
                        }
                    }
                }
                return changed;
            }
        });
        return plans;
    }

    /** After the account signs in again: drafts blocked until that sign-in (account_mismatch) become pending. */
    static boolean releaseAfterLogin(OutboxStore store, String account) throws Exception {
        return store.edit(account, new OutboxStore.RowsEdit() {
            @Override public boolean apply(List<JSONObject> rows) throws Exception {
                boolean changed = false;
                for (JSONObject row : rows) {
                    if ("blocked".equals(row.optString("status")) && "account_mismatch".equals(UploadEngine.errorOf(row))) {
                        row.put("status", "pending");
                        row.remove("error");
                        changed = true;
                    }
                }
                return changed;
            }
        });
    }
}
