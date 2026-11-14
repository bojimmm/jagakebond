package jagake.bond.app;

import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The state machine of one upload attempt, free of Android classes so it runs on the JVM against a real
 * {@link OutboxStore} (fake cipher, temp directory), a scripted {@link Transport} and a fake {@link Env}.
 * {@link UploadWorker} is a thin adapter around it.
 *
 * <p>Order of an attempt: check the draft may start (under the shared lock) and mark it {@code uploading}; pre-flight
 * health check; re-check ownership before credentials are sent; read the photo; POST; persist the outcome.
 * The outcome is persisted into the draft's own account outbox even when the active account or generation changed in
 * the meantime (audit H-1): the server may already hold the photo, so the receipt must not be dropped.
 */
final class UploadEngine {
    enum Result { DONE, RETRY, FAIL }

    /** After this many store failures in a row the work stops retrying and the draft is shown as failed. */
    static final int MAX_STORE_ATTEMPTS = 5;

    interface Env {
        long now();

        String activeAccount();

        long generation();

        /** @return the stored session of the account, or null when it is signed out. */
        JSONObject session(String account) throws Exception;

        /** Queue the next attempt for this draft after {@code delayMs}. */
        void schedule(String account, String id, long delayMs);
    }

    static final class Response {
        final int status;
        final String retryAfter;
        final byte[] body;

        Response(int status, String retryAfter, byte[] body) {
            this.status = status;
            this.retryAfter = retryAfter;
            this.body = body == null ? new byte[0] : body;
        }

        String bodyText() { return new String(body, StandardCharsets.UTF_8); }
    }

    interface Transport {
        /** GET /api/health. IOException = no usable network. */
        Response health() throws IOException;

        /** POST /api/analyze. IOException = no usable network (timeouts included). */
        Response upload(JSONObject session, JSONObject fields, String requestId, byte[] image) throws IOException;
    }

    private final OutboxStore store;
    private final Env env;
    private final Transport transport;
    private final Object lock;

    UploadEngine(OutboxStore store, Env env, Transport transport, Object lock) {
        this.store = store;
        this.env = env;
        this.transport = transport;
        this.lock = lock;
    }

    /** @param runAttempt WorkManager's retry count for this work (0 on the first run). */
    Result run(String account, String id, int runAttempt) {
        try {
            return attempt(account, id);
        } catch (Exception e) {
            return storeFailure(account, id, runAttempt);
        }
    }

    private Result attempt(String account, String id) throws Exception {
        final long generation;
        final JSONObject fields;
        synchronized (lock) {
            if (!account.equals(env.activeAccount())) return Result.DONE;
            if (env.session(account) == null) return Result.DONE;
            JSONObject meta = store.meta(account, id);
            if (meta == null) return Result.DONE;
            String status = meta.optString("status");
            if (!UploadPolicy.uploadStartAllowed(status)) return Result.DONE;
            if ("blocked".equals(status) && !SyncStatusPolicy.retryOnExplicitSync(status, errorOf(meta))) return Result.DONE;
            long now = env.now();
            long next = meta.optLong("nextAttemptAtMs", 0);
            if (next > now) {
                env.schedule(account, id, next - now);
                return Result.DONE;
            }
            JSONObject stored = meta.optJSONObject("fields");
            fields = stored == null ? new JSONObject() : stored;
            generation = env.generation();
            store.update(account, id, new OutboxStore.RowEdit() {
                @Override public boolean apply(JSONObject row) throws Exception {
                    row.put("status", "uploading");
                    row.remove("error");
                    row.remove("nextAttemptAtMs");
                    return true;
                }
            });
        }

        boolean needsTree = !fields.isNull("cropId") && !fields.optString("cropId", "").isEmpty();
        UploadPolicy.Decision early;
        try {
            Response health = transport.health();
            String healthDecision = SyncStatusPolicy.healthDecision(health.status, health.bodyText(), needsTree);
            early = UploadPolicy.forHealth(healthDecision, health.retryAfter, env.now());
        } catch (IOException noNetwork) {
            early = UploadPolicy.Decision.network();
        }
        if (early != null) return finish(account, id, early);

        final JSONObject session;
        synchronized (lock) {
            JSONObject current = store.meta(account, id);
            JSONObject currentSession = env.session(account);
            if (!UploadPolicy.readyForPost(env.activeAccount(), account, env.generation(), generation,
                    current == null ? null : current.optString("status"), currentSession != null)) {
                abandon(account, id);
                return Result.DONE;
            }
            session = currentSession;
        }

        OutboxStore.Draft draft;
        try {
            draft = store.readDraft(account, id);
        } catch (OutboxStore.PayloadException unreadable) {
            return finish(account, id, UploadPolicy.Decision.failed(unreadable.missing ? "image_missing" : "image_unreadable"));
        }
        if (draft == null) return Result.DONE;
        if (draft.image == null) return finish(account, id, UploadPolicy.Decision.failed("image_unreadable"));

        UploadPolicy.Decision decision;
        try {
            Response response = transport.upload(session, fields, id, draft.image);
            decision = UploadPolicy.forUpload(response.status, response.retryAfter, response.bodyText(), env.now());
        } catch (IOException noNetwork) {
            decision = UploadPolicy.Decision.network();
        }
        return finish(account, id, decision);
    }

    /** Persist the outcome into the owning account's outbox, whoever is active now. */
    private Result finish(String account, String id, final UploadPolicy.Decision decision) throws Exception {
        synchronized (lock) {
            final long now = env.now();
            final boolean[] applied = {false};
            store.update(account, id, new OutboxStore.RowEdit() {
                @Override public boolean apply(JSONObject row) throws Exception {
                    if (!acceptsOutcome(row.optString("status"), decision)) return false;
                    decision.apply(row, now);
                    applied[0] = true;
                    return true;
                }
            });
            if (applied[0] && decision.scheduleDelayMs >= 0 && account.equals(env.activeAccount())) {
                env.schedule(account, id, decision.scheduleDelayMs);
            }
        }
        return Result.DONE;
    }

    /**
     * Whether the outcome of this attempt may be written into a row now in {@code status}. Normally the row is still
     * {@code uploading}. A server receipt is also kept when a recovery pass raced this attempt and already put the row
     * back to {@code pending}/{@code blocked}: the server holds the photo, so the receipt must win (audit H-1).
     * Rows the farmer removed, edited or that reached a terminal state are never touched.
     */
    static boolean acceptsOutcome(String status, UploadPolicy.Decision decision) {
        if ("uploading".equals(status)) return true;
        return decision.kind == UploadPolicy.Decision.Kind.SUBMITTED && ("pending".equals(status) || "blocked".equals(status));
    }

    /** The world changed before credentials were sent: put the draft back and let the next sign-in schedule it. */
    private void abandon(String account, String id) throws Exception {
        store.update(account, id, new OutboxStore.RowEdit() {
            @Override public boolean apply(JSONObject row) throws Exception {
                if (!"uploading".equals(row.optString("status"))) return false;
                row.put("status", "pending");
                return true;
            }
        });
        if (account.equals(env.activeAccount())) env.schedule(account, id, 0);
    }

    private Result storeFailure(String account, String id, int runAttempt) {
        if (runAttempt + 1 < MAX_STORE_ATTEMPTS) return Result.RETRY;
        try {
            store.update(account, id, new OutboxStore.RowEdit() {
                @Override public boolean apply(JSONObject row) throws Exception {
                    String status = row.optString("status");
                    if (!"uploading".equals(status) && !"pending".equals(status)) return false;
                    row.put("status", "failed");
                    row.put("error", "store_error");
                    row.remove("nextAttemptAtMs");
                    return true;
                }
            });
        } catch (Exception ignored) {
            // The store itself is broken; the work still stops and list() will surface the same error to the farmer.
        }
        return Result.FAIL;
    }

    static String errorOf(JSONObject row) {
        return row.has("error") && !row.isNull("error") ? row.optString("error", "") : "";
    }
}
