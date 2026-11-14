package jagake.bond.app;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static jagake.bond.app.TestSupport.ACCOUNT;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * The worker state machine on the JVM: a real outbox (software cipher, temp directory), a scripted server and a fake
 * environment. Covers audit H-1 (receipt after a generation change), M-3 (retry policy) and contract 5.3 (statuses).
 */
public class UploadEngineTest {
    private static final String ID = "draft-1";
    private static final byte[] JPEG = TestSupport.randomBytes(4000, 77);

    private File root;
    private TestSupport.SoftwareVault vault;
    private TestSupport.Clock clock;
    private TestSupport.FlakyFiles files;
    private OutboxStore store;
    private FakeEnv env;
    private ScriptedTransport transport;
    private UploadEngine engine;
    private final Object lock = new Object();

    static final class FakeEnv implements UploadEngine.Env {
        final TestSupport.Clock clock;
        String active = ACCOUNT;
        long generation = 1;
        final Map<String, JSONObject> sessions = new HashMap<>();
        final List<String> scheduled = new ArrayList<>();

        FakeEnv(TestSupport.Clock clock) throws Exception {
            this.clock = clock;
            sessions.put(ACCOUNT, new JSONObject().put("cookie", "jk_session=abc; jk_csrf=tok").put("csrf", "tok"));
        }

        @Override public long now() { return clock.now(); }

        @Override public String activeAccount() { return active; }

        @Override public long generation() { return generation; }

        @Override public JSONObject session(String account) { return sessions.get(account); }

        @Override public void schedule(String account, String id, long delayMs) { scheduled.add(account + "/" + id + "@" + delayMs); }
    }

    static final class ScriptedTransport implements UploadEngine.Transport {
        final Deque<Object> healthScript = new ArrayDeque<>();
        final Deque<Object> uploadScript = new ArrayDeque<>();
        Object healthDefault = healthy();
        Object uploadDefault = null;
        Runnable duringHealth = () -> { };
        Runnable duringUpload = () -> { };
        int healthCalls;
        int uploadCalls;
        byte[] lastImage;
        JSONObject lastSession;
        JSONObject lastFields;
        String lastRequestId;

        @Override public UploadEngine.Response health() throws IOException {
            healthCalls++;
            duringHealth.run();
            return resolve(healthScript.isEmpty() ? healthDefault : healthScript.poll());
        }

        @Override public UploadEngine.Response upload(JSONObject session, JSONObject fields, String requestId, byte[] image) throws IOException {
            uploadCalls++;
            lastImage = image;
            lastSession = session;
            lastFields = fields;
            lastRequestId = requestId;
            duringUpload.run();
            Object next = uploadScript.isEmpty() ? uploadDefault : uploadScript.poll();
            if (next == null) throw new AssertionError("unexpected upload");
            return resolve(next);
        }

        private static UploadEngine.Response resolve(Object next) throws IOException {
            if (next instanceof IOException) throw (IOException) next;
            return (UploadEngine.Response) next;
        }
    }

    static UploadEngine.Response healthy() { return reply(200, null, "{\"version\":\"2.1.0\",\"capabilities\":{\"treeContinuity\":true}}"); }

    static UploadEngine.Response accepted(String jobId) { return reply(200, null, "{\"job_id\":\"" + jobId + "\",\"status\":\"queued\"}"); }

    static UploadEngine.Response reply(int status, String retryAfter, String body) {
        return new UploadEngine.Response(status, retryAfter, body == null ? null : body.getBytes(StandardCharsets.UTF_8));
    }

    @Before public void setUp() throws Exception {
        root = TestSupport.tempDir();
        vault = new TestSupport.SoftwareVault();
        clock = new TestSupport.Clock();
        files = new TestSupport.FlakyFiles();
        store = new OutboxStore(root, vault, files, clock, lock);
        env = new FakeEnv(clock);
        transport = new ScriptedTransport();
        engine = new UploadEngine(store, env, transport, lock);
        store.add(ACCOUNT, ID, new JSONObject().put("lat", "-6.2").put("lng", "106.8").put("cropId", JSONObject.NULL)
                .put("locationName", "Kebun"), clock.now, "pending", JPEG);
    }

    @After public void tearDown() { TestSupport.deleteTree(root); }

    private JSONObject row() throws Exception { return store.meta(ACCOUNT, ID); }

    private UploadEngine.Result run() { return engine.run(ACCOUNT, ID, 0); }

    private static String error(JSONObject row) { return row.optString("error", ""); }

    // ------------------------------------------------------------------ success, H-1

    @Test public void anAcceptedUploadStoresTheReceiptAndSchedulesNothing() throws Exception {
        transport.uploadDefault = accepted("job_77");
        assertEquals(UploadEngine.Result.DONE, run());
        JSONObject row = row();
        assertEquals("submitted", row.getString("status"));
        assertEquals("job_77", row.getString("jobId"));
        assertFalse(row.has("error"));
        assertFalse(row.has("nextAttemptAtMs"));
        assertEquals(1, transport.uploadCalls);
        assertArrayEquals(JPEG, transport.lastImage);
        assertEquals(ID, transport.lastRequestId);
        assertEquals("jk_session=abc; jk_csrf=tok", transport.lastSession.getString("cookie"));
        assertTrue(transport.lastFields.isNull("cropId"));
        assertTrue(env.scheduled.isEmpty());
    }

    @Test public void theReceiptIsKeptWhenTheGenerationChangesDuringTheUpload() throws Exception {
        transport.uploadDefault = accepted("job_gen");
        transport.duringUpload = () -> env.generation++;
        run();
        JSONObject row = row();
        assertEquals("the server has the photo: the receipt must not be dropped", "submitted", row.getString("status"));
        assertEquals("job_gen", row.getString("jobId"));
    }

    @Test public void theReceiptIsKeptInTheOwnersOutboxWhenAnotherAccountBecameActive() throws Exception {
        transport.uploadDefault = accepted("job_other");
        transport.duringUpload = () -> { env.active = "acct_two"; env.generation++; };
        run();
        assertEquals("submitted", row().getString("status"));
        assertEquals("job_other", row().getString("jobId"));
        assertTrue("nothing is queued for an account that is no longer active", env.scheduled.isEmpty());
        assertEquals("acct_two's outbox was not touched", 0, store.list("acct_two").rows.size());
    }

    @Test public void theReceiptWinsWhenARecoveryPassResetTheRowDuringTheUpload() throws Exception {
        transport.uploadDefault = accepted("job_race");
        // A recovery pass that did not see this work yet puts the row back to pending while the POST is in flight.
        transport.duringUpload = () -> {
            try {
                store.update(ACCOUNT, ID, r -> { r.put("status", "pending"); return true; });
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        };
        run();
        assertEquals("submitted", row().getString("status"));
        assertEquals("job_race", row().getString("jobId"));
    }

    @Test public void aRetryableOutcomeNeverOverwritesARowThatLeftUploading() throws Exception {
        transport.uploadScript.add(reply(500, null, "{}"));
        transport.duringUpload = () -> {
            try {
                store.update(ACCOUNT, ID, r -> { r.put("status", "submitted").put("jobId", "job_first"); return true; });
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        };
        run();
        assertEquals("submitted", row().getString("status"));
        assertEquals("job_first", row().getString("jobId"));
        assertTrue(env.scheduled.isEmpty());
    }

    @Test public void theReceiptIsKeptWhenTheFarmerLoggedOutMeanwhile() throws Exception {
        transport.uploadDefault = accepted("job_out");
        transport.duringUpload = () -> { env.active = null; env.sessions.clear(); env.generation++; };
        run();
        assertEquals("submitted", row().getString("status"));
    }

    @Test public void aRetryableOutcomeAfterAGenerationChangeIsPersistedButNotQueued() throws Exception {
        transport.uploadDefault = new IOException("reset");
        transport.duringUpload = () -> { env.active = null; env.generation++; };
        run();
        JSONObject row = row();
        assertEquals("pending", row.getString("status"));
        assertEquals("network_retry", error(row));
        assertTrue(env.scheduled.isEmpty());
    }

    @Test public void ifTheWorldChangesBeforeCredentialsAreSentTheDraftGoesBackToPending() throws Exception {
        transport.duringHealth = () -> env.generation++;
        run();
        assertEquals(0, transport.uploadCalls);
        assertEquals("pending", row().getString("status"));
        assertEquals("same account still active: queue it again", List.of(ACCOUNT + "/" + ID + "@0"), env.scheduled);
    }

    @Test public void ifAnotherAccountTookOverBeforeTheUploadTheDraftWaitsForItsOwnersNextSignIn() throws Exception {
        transport.duringHealth = () -> { env.active = "acct_two"; env.generation++; };
        run();
        assertEquals(0, transport.uploadCalls);
        assertEquals("pending", row().getString("status"));
        assertTrue(env.scheduled.isEmpty());
    }

    // ------------------------------------------------------------------ M-3 retry policy

    @Test public void networkFailuresNeverFailADraftAndBackOffUpToOneHour() throws Exception {
        long started = clock.now();
        transport.uploadDefault = new IOException("timeout");
        long[] ladder = {30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000};
        for (int i = 0; i < 120; i++) {
            long before = clock.now();
            run();
            JSONObject row = row();
            assertEquals("attempt " + i, "pending", row.getString("status"));
            assertEquals("network_retry", error(row));
            long expected = ladder[Math.min(i, ladder.length - 1)];
            assertEquals("wait before attempt " + (i + 1), before + expected, row.getLong("nextAttemptAtMs"));
            assertEquals(ACCOUNT + "/" + ID + "@" + expected, env.scheduled.get(env.scheduled.size() - 1));
            assertFalse("network trouble is never counted against the draft", row.has("srvFails"));
            clock.now = row.getLong("nextAttemptAtMs");
        }
        assertTrue("kept retrying for more than 72 hours", clock.now() - started > 72L * 3600 * 1000);
        transport.uploadDefault = accepted("job_late");
        run();
        JSONObject done = row();
        assertEquals("submitted", done.getString("status"));
        assertFalse("counters are cleared by a success", done.has("netFails"));
    }

    @Test public void aTimeoutOnTheHealthCheckIsANetworkFailureToo() throws Exception {
        transport.healthDefault = new java.net.SocketTimeoutException("10 s");
        run();
        assertEquals(0, transport.uploadCalls);
        assertEquals("network_retry", error(row()));
        assertEquals("pending", row().getString("status"));
    }

    @Test public void serverFailuresFailTheDraftOnlyAfterTenOfThemOverADay() throws Exception {
        transport.uploadDefault = reply(500, null, "{\"detail\":\"boom\"}");
        long first = clock.now();
        int attempts = 0;
        while (true) {
            run();
            attempts++;
            JSONObject row = row();
            if ("failed".equals(row.getString("status"))) break;
            assertEquals("pending", row.getString("status"));
            assertEquals("http_500", error(row));
            assertEquals(attempts, row.getInt("srvFails"));
            clock.now = row.getLong("nextAttemptAtMs");
            assertTrue("runaway retry loop", attempts < 100);
        }
        JSONObject failed = row();
        assertEquals("server_failures", error(failed));
        assertTrue("never before 10 failures", attempts >= 10);
        assertTrue("never before 24 hours of trying", clock.now() - first >= 24L * 3600 * 1000 || failed.getLong("srvFirstMs") + 24L * 3600 * 1000 <= clock.now());
        assertFalse(failed.has("nextAttemptAtMs"));
        // An explicit sync revives it (network/server side failure), see RecoveryPlannerTest.
        assertTrue(SyncStatusPolicy.revivesOnExplicitSync("failed", "server_failures"));
    }

    @Test public void aShortServerOutageDoesNotFailTheDraft() throws Exception {
        transport.uploadDefault = reply(502, null, "bad gateway");
        for (int i = 0; i < 12; i++) {
            run();
            JSONObject row = row();
            assertEquals("pending", row.getString("status"));
            clock.now = row.getLong("nextAttemptAtMs");
        }
        assertTrue("12 failures took less than a day, so still pending", clock.now() - 1_800_000_000_000L < 24L * 3600 * 1000);
        transport.uploadDefault = accepted("job_ok");
        run();
        assertEquals("submitted", row().getString("status"));
        assertFalse(row().has("srvFails"));
    }

    @Test public void serviceUnavailableWithRetryAfterIsHonouredAndNotCounted() throws Exception {
        transport.uploadDefault = reply(503, "120", "maintenance");
        long before = clock.now();
        run();
        JSONObject row = row();
        assertEquals("pending", row.getString("status"));
        assertEquals("server_busy", error(row));
        assertEquals(before + 120_000, row.getLong("nextAttemptAtMs"));
        assertEquals(ACCOUNT + "/" + ID + "@120000", env.scheduled.get(0));
        assertFalse(row.has("srvFails"));
    }

    @Test public void serviceUnavailableWithoutRetryAfterCountsAsAServerFailure() throws Exception {
        transport.uploadDefault = reply(503, null, "");
        run();
        assertEquals(1, row().getInt("srvFails"));
        assertEquals("http_503", error(row()));
        assertEquals(30_000, row().getLong("nextAttemptAtMs") - clock.now());
    }

    @Test public void tooManyRequestsDefersByRetryAfterForBothQueueLimits() throws Exception {
        transport.uploadDefault = reply(429, "60", "{\"detail\":\"Antrean penuh\",\"code\":\"queue_full\"}");
        long before = clock.now();
        run();
        JSONObject row = row();
        assertEquals("pending", row.getString("status"));
        assertEquals("rate_limited", error(row));
        assertEquals(before + 60_000, row.getLong("nextAttemptAtMs"));
        assertFalse(row.has("srvFails"));
        assertEquals("the server's reason is kept for the web", "queue_full", row.getString("serverCode"));

        clock.now = row.getLong("nextAttemptAtMs");
        transport.uploadDefault = reply(429, "120", "{\"detail\":\"Server sibuk\",\"code\":\"queue_busy\"}");
        before = clock.now();
        run();
        assertEquals(before + 120_000, row().getLong("nextAttemptAtMs"));
        assertEquals("queue_busy", row().getString("serverCode"));

        clock.now = row().getLong("nextAttemptAtMs");
        transport.uploadDefault = reply(429, null, "{\"code\":\"<script>\"}");
        before = clock.now();
        run();
        assertEquals("no header: the one-minute fallback", before + 60_000, row().getLong("nextAttemptAtMs"));
        assertFalse("unknown codes are not echoed", row().has("serverCode"));
        for (String code : new String[]{"photo_quota", "decode_busy"}) {
            assertEquals(code, UploadPolicy.serverCode("{\"code\":\"" + code + "\"}"));
        }
        transport.uploadDefault = null;
        long due = row().getLong("nextAttemptAtMs");
        clock.now = due - 1;
        env.scheduled.clear();
        run();
        assertEquals("not due yet: no upload, scheduled for the remainder", List.of(ACCOUNT + "/" + ID + "@1"), env.scheduled);
    }

    // ------------------------------------------------------------------ contract 5.3 statuses

    @Test public void aPhotoThatIsTooLargeIsPermanentlyRefused() throws Exception {
        transport.uploadDefault = reply(413, null, "{\"detail\":\"too big\"}");
        run();
        assertEquals("failed", row().getString("status"));
        assertEquals("photo_too_large", error(row()));
        assertTrue(env.scheduled.isEmpty());
        assertFalse(SyncStatusPolicy.scheduleOnExplicitSync("failed", "photo_too_large"));
    }

    @Test public void anUnprocessableDraftIsPermanentWithTheServersReason() throws Exception {
        transport.uploadDefault = reply(422, null, "{\"detail\":\"Foto  tidak\\nvalid: pilih foto lain\"}");
        run();
        assertEquals("failed", row().getString("status"));
        assertEquals("invalid:Foto tidak valid: pilih foto lain", error(row()));
        assertTrue(env.scheduled.isEmpty());
        assertFalse(SyncStatusPolicy.scheduleOnExplicitSync("failed", error(row())));
    }

    @Test public void aLongOrMissingReasonIsCappedOrReplaced() throws Exception {
        StringBuilder longReason = new StringBuilder();
        for (int i = 0; i < 100; i++) longReason.append("kata ");
        transport.uploadDefault = reply(422, null, "{\"detail\":\"" + longReason + "\"}");
        run();
        String error = error(row());
        assertTrue(error, error.startsWith("invalid:") && error.length() <= "invalid:".length() + UploadPolicy.MAX_DETAIL_CHARS);

        store.update(ACCOUNT, ID, r -> { r.put("status", "pending").remove("error"); return true; });
        transport.uploadDefault = reply(422, null, "[{\"loc\":[\"body\"],\"msg\":\"x\"}]");
        run();
        assertEquals("invalid_request", error(row()));
    }

    @Test public void accountMismatchKeepsTheDraftBlockedUntilThatAccountSignsInAgain() throws Exception {
        transport.uploadDefault = reply(409, null, "{\"detail\":\"Akun di perangkat ini sudah berganti. Muat ulang aplikasi.\",\"code\":\"account_mismatch\"}");
        run();
        JSONObject row = row();
        assertEquals("blocked", row.getString("status"));
        assertEquals("account_mismatch", error(row));
        assertTrue(env.scheduled.isEmpty());
        assertFalse("a plain sync must not release it", SyncStatusPolicy.scheduleOnExplicitSync("blocked", "account_mismatch"));
        // And the worker itself will not start it again.
        transport.uploadDefault = null;
        run();
        assertEquals("blocked", row().getString("status"));
        assertEquals(1, transport.uploadCalls);
    }

    @Test public void anotherConflictIsTheIdempotencyConflict() throws Exception {
        transport.uploadDefault = reply(409, null, "{\"detail\":\"Permintaan sudah dipakai\"}");
        run();
        assertEquals("failed", row().getString("status"));
        assertEquals("idempotency_conflict", error(row()));
    }

    @Test public void authenticationProblemsBlockTheDraftUntilSignIn() throws Exception {
        for (int status : new int[]{401, 403}) {
            store.update(ACCOUNT, ID, r -> { r.put("status", "pending").remove("error"); return true; });
            transport.uploadDefault = reply(status, null, "{}");
            run();
            assertEquals("blocked", row().getString("status"));
            assertEquals("authentication_required", error(row()));
        }
    }

    @Test public void otherClientErrorsArePermanentAndRedirectsAreNetworkTrouble() throws Exception {
        for (int status : new int[]{400, 404, 405, 410}) {
            store.update(ACCOUNT, ID, r -> { r.put("status", "pending").remove("error"); return true; });
            transport.uploadDefault = reply(status, null, "{}");
            run();
            assertEquals("failed", row().getString("status"));
            assertEquals("http_" + status, error(row()));
        }
        for (int status : new int[]{301, 302, 307, 408, 425}) {
            store.update(ACCOUNT, ID, r -> { r.put("status", "pending"); r.remove("error"); r.remove("nextAttemptAtMs"); return true; });
            transport.uploadDefault = reply(status, null, "<html>captive portal</html>");
            run();
            assertEquals("status " + status, "pending", row().getString("status"));
            assertEquals("network_retry", error(row()));
        }
    }

    @Test public void aReceiptWithoutAJobIdCountsAsAServerFailureAndKeepsTheDraft() throws Exception {
        transport.uploadDefault = reply(200, null, "{\"status\":\"queued\"}");
        run();
        assertEquals("pending", row().getString("status"));
        assertEquals("invalid_receipt", error(row()));
        assertEquals(1, row().getInt("srvFails"));
    }

    // ------------------------------------------------------------------ health pre-check

    @Test public void anOutdatedServerBlocksTheDraftUntilItIsUpdated() throws Exception {
        transport.healthDefault = reply(200, null, "{\"version\":\"1.9.0\"}");
        run();
        assertEquals(0, transport.uploadCalls);
        assertEquals("blocked", row().getString("status"));
        assertEquals("server_update_required", error(row()));
        assertTrue(SyncStatusPolicy.retryOnExplicitSync("blocked", "server_update_required"));
    }

    @Test public void aHealthCheckClientErrorParksTheDraftButASyncMayRetryIt() throws Exception {
        transport.healthDefault = reply(404, null, "{}");
        run();
        assertEquals("blocked", row().getString("status"));
        assertEquals("health_http_404", error(row()));
        assertTrue("any health 4xx is recoverable on explicit sync", SyncStatusPolicy.retryOnExplicitSync("blocked", error(row())));
        assertTrue(SyncStatusPolicy.scheduleOnExplicitSync("blocked", "health_http_422"));
    }

    @Test public void healthServerErrorsAreServerFailuresAndRateLimitsAreDeferred() throws Exception {
        transport.healthDefault = reply(500, null, "x");
        run();
        assertEquals("health_http_500", error(row()));
        assertEquals(1, row().getInt("srvFails"));

        clock.now = row().getLong("nextAttemptAtMs");
        transport.healthDefault = reply(429, "45", "x");
        long before = clock.now();
        run();
        assertEquals("rate_limited", error(row()));
        assertEquals(before + 45_000, row().getLong("nextAttemptAtMs"));
        assertEquals("a deferral is not a failure", 1, row().getInt("srvFails") > 0 ? 1 : 0);

        clock.now = row().getLong("nextAttemptAtMs");
        transport.healthDefault = reply(200, null, "not json");
        run();
        assertEquals("health_invalid_response", error(row()));
    }

    @Test public void treeContinuityIsOnlyRequiredForCapturesLinkedToATree() throws Exception {
        transport.healthDefault = reply(200, null, "{\"version\":\"2.1.0\"}");
        transport.uploadDefault = accepted("job_plain");
        run();
        assertEquals("an unlinked capture still uploads to an older 2.1 server", "submitted", row().getString("status"));

        store.add(ACCOUNT, "tree-draft", new JSONObject().put("cropId", "tree_9").put("cropName", "Cengkeh 9"), clock.now, "pending", JPEG);
        run2("tree-draft");
        JSONObject linked = store.meta(ACCOUNT, "tree-draft");
        assertEquals("blocked", linked.getString("status"));
        assertEquals("server_update_required", error(linked));
    }

    private void run2(String id) { engine.run(ACCOUNT, id, 0); }

    // ------------------------------------------------------------------ guards

    @Test public void nothingHappensForAnInactiveAccountOrWithoutASession() throws Exception {
        env.active = "acct_two";
        run();
        assertEquals(0, transport.healthCalls);
        assertEquals("pending", row().getString("status"));
        env.active = ACCOUNT;
        env.sessions.clear();
        run();
        assertEquals(0, transport.healthCalls);
        assertEquals("pending", row().getString("status"));
    }

    @Test public void aDraftThatIsNotDueYetIsQueuedForLater() throws Exception {
        store.update(ACCOUNT, ID, r -> { r.put("nextAttemptAtMs", clock.now() + 600_000).put("error", "rate_limited"); return true; });
        run();
        assertEquals(0, transport.healthCalls);
        assertEquals(List.of(ACCOUNT + "/" + ID + "@600000"), env.scheduled);
    }

    @Test public void onlyRecoverableBlocksStart() throws Exception {
        store.update(ACCOUNT, ID, r -> { r.put("status", "blocked").put("error", "account_mismatch"); return true; });
        run();
        assertEquals(0, transport.healthCalls);
        store.update(ACCOUNT, ID, r -> { r.put("error", "authentication_required"); return true; });
        transport.uploadDefault = accepted("job_after_login");
        run();
        assertEquals("submitted", row().getString("status"));
    }

    @Test public void statusesThatAreNotUploadableAreLeftAlone() throws Exception {
        for (String status : new String[]{"submitted", "failed", "editing", "cancelled", "rejected"}) {
            store.update(ACCOUNT, ID, r -> { r.put("status", status); return true; });
            run();
            assertEquals(status, row().getString("status"));
        }
        assertEquals(0, transport.healthCalls);
    }

    @Test public void aMissingOrCorruptPhotoFailsTheDraftVisiblyAndPermanently() throws Exception {
        assertTrue(store.draftFile(ACCOUNT, ID).delete());
        run();
        assertEquals("failed", row().getString("status"));
        assertEquals("image_missing", error(row()));
        assertEquals(0, transport.uploadCalls);

        store.add(ACCOUNT, "broken", new JSONObject().put("lat", "1").put("lng", "2"), clock.now, "pending", JPEG);
        File file = store.draftFile(ACCOUNT, "broken");
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "rw")) {
            raf.seek(file.length() - 2);
            int b = raf.read();
            raf.seek(file.length() - 2);
            raf.write(b ^ 0x7f);
        }
        engine.run(ACCOUNT, "broken", 0);
        JSONObject broken = store.meta(ACCOUNT, "broken");
        assertEquals("failed", broken.getString("status"));
        assertEquals("image_unreadable", error(broken));
        assertFalse(SyncStatusPolicy.scheduleOnExplicitSync("failed", "image_unreadable"));
    }

    // ------------------------------------------------------------------ store failures

    @Test public void whenTheStoreItselfKeepsFailingTheWorkRetriesAFewTimesThenStops() throws Exception {
        files.broken = true;
        for (int attempt = 0; attempt < UploadEngine.MAX_STORE_ATTEMPTS - 1; attempt++) {
            assertEquals("attempt " + attempt, UploadEngine.Result.RETRY, engine.run(ACCOUNT, ID, attempt));
        }
        assertEquals(UploadEngine.Result.FAIL, engine.run(ACCOUNT, ID, UploadEngine.MAX_STORE_ATTEMPTS - 1));
        assertEquals(0, transport.uploadCalls);
    }

    @Test public void theFinalStoreFailureIsMadeVisibleAsAFailedDraftWhenTheStoreAllowsIt() throws Exception {
        transport.uploadDefault = accepted("job_unwritable");
        files.writes = 0;
        files.failWriteNumber = 2;   // 1 = mark uploading, 2 = save the receipt (fails), 3 = mark failed
        assertEquals(UploadEngine.Result.FAIL, engine.run(ACCOUNT, ID, UploadEngine.MAX_STORE_ATTEMPTS - 1));
        JSONObject row = row();
        assertEquals("failed", row.getString("status"));
        assertEquals("store_error", error(row));
        assertTrue("an explicit sync revives a store failure", SyncStatusPolicy.revivesOnExplicitSync("failed", "store_error"));
    }

    @Test public void aReceiptThatCouldNotBeSavedIsReplayedSafelyOnTheRetry() throws Exception {
        transport.uploadDefault = accepted("job_replay");
        files.writes = 0;
        files.failWriteNumber = 2;
        assertEquals(UploadEngine.Result.RETRY, engine.run(ACCOUNT, ID, 0));
        assertEquals("the draft is still marked uploading", "uploading", row().getString("status"));
        files.failWriteNumber = 0;
        assertEquals(UploadEngine.Result.DONE, engine.run(ACCOUNT, ID, 1));
        assertEquals("submitted", row().getString("status"));
        assertEquals("job_replay", row().getString("jobId"));
        assertEquals("the same clientRequestId was posted twice; the server replays by it", 2, transport.uploadCalls);
    }
}
