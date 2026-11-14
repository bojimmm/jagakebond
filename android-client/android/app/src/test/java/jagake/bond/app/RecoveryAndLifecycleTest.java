package jagake.bond.app;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static jagake.bond.app.RecoveryPlanner.State.NONE;
import static jagake.bond.app.RecoveryPlanner.State.RUNNING;
import static jagake.bond.app.RecoveryPlanner.State.WAITING;
import static jagake.bond.app.TestSupport.ACCOUNT;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/** Audit H-1 recovery, the explicit sync, photo deletion (M-1) and the pending revoke queue. */
public class RecoveryAndLifecycleTest {
    private File root;
    private TestSupport.SoftwareVault vault;
    private TestSupport.Clock clock;
    private OutboxStore store;
    private final Object lock = new Object();

    @Before public void setUp() throws Exception {
        root = TestSupport.tempDir();
        vault = new TestSupport.SoftwareVault();
        clock = new TestSupport.Clock();
        store = new OutboxStore(root, vault, new TestSupport.JvmFiles(), clock, lock);
    }

    @After public void tearDown() { TestSupport.deleteTree(root); }

    private void draft(String id, String status, String error, long next) throws Exception {
        store.add(ACCOUNT, id, new JSONObject().put("lat", "1").put("lng", "2"), clock.now(), status, TestSupport.randomBytes(300, id.hashCode()));
        store.update(ACCOUNT, id, row -> {
            if (error != null) row.put("error", error);
            if (next > 0) row.put("nextAttemptAtMs", next);
            return true;
        });
    }

    private static RecoveryPlanner.WorkProbe probe(Map<String, RecoveryPlanner.State> states) {
        return account -> states;
    }

    private static RecoveryPlanner.Plan planFor(List<RecoveryPlanner.Plan> plans, String id) {
        for (RecoveryPlanner.Plan plan : plans) if (plan.id.equals(id)) return plan;
        return null;
    }

    // ------------------------------------------------------------------ H-1

    @Test public void uploadingRowsWithoutAnyWorkGoBackToPendingAndAreQueued() throws Exception {
        draft("stuck", "uploading", null, 0);
        draft("running", "uploading", null, 0);
        draft("queued", "uploading", null, 0);
        Map<String, RecoveryPlanner.State> states = new HashMap<>();
        states.put("running", RUNNING);
        states.put("queued", WAITING);
        List<RecoveryPlanner.Plan> plans = RecoveryPlanner.run(store, ACCOUNT, probe(states), clock.now());
        assertEquals("pending", store.meta(ACCOUNT, "stuck").getString("status"));
        assertEquals("uploading", store.meta(ACCOUNT, "running").getString("status"));
        assertEquals("uploading", store.meta(ACCOUNT, "queued").getString("status"));
        assertEquals(1, plans.size());
        assertEquals("stuck", plans.get(0).id);
        assertEquals(0, plans.get(0).delayMs);
        assertFalse(plans.get(0).replace);
    }

    @Test public void whenWorkManagerCannotBeAskedUploadingRowsAreLeftAlone() throws Exception {
        draft("maybe", "uploading", null, 0);
        List<RecoveryPlanner.Plan> plans = RecoveryPlanner.run(store, ACCOUNT, a -> { throw new java.util.concurrent.TimeoutException(); }, clock.now());
        assertEquals("uploading", store.meta(ACCOUNT, "maybe").getString("status"));
        assertTrue(plans.isEmpty());
    }

    @Test public void recoveryIsIdempotent() throws Exception {
        draft("stuck", "uploading", null, 0);
        RecoveryPlanner.run(store, ACCOUNT, probe(new HashMap<>()), clock.now());
        int seals = vault.sealCount;
        List<RecoveryPlanner.Plan> again = RecoveryPlanner.run(store, ACCOUNT, probe(new HashMap<>()), clock.now());
        assertEquals("pending rows are queued (KEEP makes a duplicate harmless) but nothing is rewritten", seals, vault.sealCount);
        assertEquals(1, again.size());
    }

    // ------------------------------------------------------------------ explicit sync

    @Test public void anExplicitSyncReleasesNetworkBackoffButHonoursWhatTheServerAskedFor() throws Exception {
        long later = clock.now() + 3_000_000;
        draft("net", "pending", "network_retry", later);
        draft("limited", "pending", "rate_limited", later);
        draft("busy", "pending", "server_busy", later);
        draft("fresh", "pending", null, 0);
        Map<String, RecoveryPlanner.State> states = new HashMap<>();
        states.put("net", WAITING);
        states.put("limited", WAITING);
        List<RecoveryPlanner.Plan> plans = RecoveryPlanner.run(store, ACCOUNT, probe(states), clock.now());
        assertFalse(store.meta(ACCOUNT, "net").has("nextAttemptAtMs"));
        assertTrue("the waiting delayed attempt is replaced so it runs now", planFor(plans, "net").replace);
        assertEquals(0, planFor(plans, "net").delayMs);
        assertEquals(later, store.meta(ACCOUNT, "limited").getLong("nextAttemptAtMs"));
        assertNull("an attempt with the server's delay is already queued", planFor(plans, "limited"));
        assertEquals(later - clock.now(), planFor(plans, "busy").delayMs);
        assertEquals(0, planFor(plans, "fresh").delayMs);
    }

    @Test public void aRunningAttemptIsNeverReplaced() throws Exception {
        draft("busy", "pending", "network_retry", clock.now() + 60_000);
        Map<String, RecoveryPlanner.State> states = new HashMap<>();
        states.put("busy", RUNNING);
        assertTrue(RecoveryPlanner.run(store, ACCOUNT, probe(states), clock.now()).isEmpty());
    }

    @Test public void blockedDraftsAreQueuedOnlyForRecoverableReasons() throws Exception {
        draft("auth", "blocked", "authentication_required", 0);
        draft("old", "blocked", "server_update_required", 0);
        draft("health", "blocked", "health_http_404", 0);
        draft("mismatch", "blocked", "account_mismatch", 0);
        draft("weird", "blocked", "unrecognized", 0);
        List<RecoveryPlanner.Plan> plans = RecoveryPlanner.run(store, ACCOUNT, probe(new HashMap<>()), clock.now());
        assertNotNull(planFor(plans, "auth"));
        assertNotNull(planFor(plans, "old"));
        assertNotNull(planFor(plans, "health"));
        assertNull(planFor(plans, "mismatch"));
        assertNull(planFor(plans, "weird"));
    }

    @Test public void failedDraftsAreRevivedOnlyWhenTheFailureWasOnTheNetworkOrServerSide() throws Exception {
        for (String error : new String[]{"retry_limit_reached", "server_failures", "store_error"}) {
            draft("f-" + error, "failed", error, 0);
            store.update(ACCOUNT, "f-" + error, row -> { row.put("srvFails", 12).put("srvFirstMs", 5L); return true; });
        }
        String[] permanent = {"idempotency_conflict", "photo_too_large", "invalid:Foto buruk", "http_400", "image_missing", "image_unreadable"};
        for (int i = 0; i < permanent.length; i++) draft("p" + i, "failed", permanent[i], 0);
        List<RecoveryPlanner.Plan> plans = RecoveryPlanner.run(store, ACCOUNT, probe(new HashMap<>()), clock.now());
        for (String error : new String[]{"retry_limit_reached", "server_failures", "store_error"}) {
            JSONObject row = store.meta(ACCOUNT, "f-" + error);
            assertEquals("pending", row.getString("status"));
            assertFalse(row.has("error") || row.has("srvFails") || row.has("srvFirstMs"));
            assertNotNull(planFor(plans, "f-" + error));
        }
        for (int i = 0; i < permanent.length; i++) {
            assertEquals("failed", store.meta(ACCOUNT, "p" + i).getString("status"));
            assertNull(planFor(plans, "p" + i));
        }
    }

    @Test public void signingInAgainReleasesAccountMismatchBlocks() throws Exception {
        draft("mismatch", "blocked", "account_mismatch", 0);
        draft("auth", "blocked", "authentication_required", 0);
        assertTrue(RecoveryPlanner.releaseAfterLogin(store, ACCOUNT));
        assertEquals("pending", store.meta(ACCOUNT, "mismatch").getString("status"));
        assertFalse(store.meta(ACCOUNT, "mismatch").has("error"));
        assertEquals("blocked", store.meta(ACCOUNT, "auth").getString("status"));
        assertFalse(RecoveryPlanner.releaseAfterLogin(store, ACCOUNT));
    }

    @Test public void theLegacyRetryLimitFailureOfOlderReleasesIsRecoverable() {
        assertTrue(SyncStatusPolicy.scheduleOnExplicitSync("failed", "retry_limit_reached"));
        assertFalse(SyncStatusPolicy.retryOnExplicitSync("failed", "retry_limit_reached"));
    }

    // ------------------------------------------------------------------ photos (M-1)

    private PhotoArchive photos() { return new PhotoArchive(root, vault, new TestSupport.JvmFiles(), lock); }

    private static JSONObject meta() throws Exception { return new JSONObject().put("lat", -6.2).put("locationSource", "gps"); }

    @Test public void photosRoundTripAndDeleteIsIdempotentAndRemovesFileAndKey() throws Exception {
        PhotoArchive photos = photos();
        byte[] jpeg = TestSupport.randomBytes(40_000, 5);
        photos.put(ACCOUNT, "p1", jpeg, meta());
        PhotoArchive.Photo photo = photos.get(ACCOUNT, "p1");
        assertArrayEquals(jpeg, photo.jpeg);
        assertEquals("gps", photo.metadata.getString("locationSource"));
        assertNull(photos.get(ACCOUNT, "other"));
        String key = PhotoArchive.namespace(ACCOUNT, "p1");
        assertTrue(vault.hasKey(key));
        File file = photos.file(ACCOUNT, "p1");
        assertTrue(file.exists());

        assertTrue(photos.delete(ACCOUNT, "p1"));
        assertFalse(file.exists());
        assertFalse("the Keystore key goes too", vault.hasKey(key));
        assertFalse("deleting again is not an error", photos.delete(ACCOUNT, "p1"));
        assertFalse(photos.delete(ACCOUNT, "never-existed"));
        assertNull(photos.get(ACCOUNT, "p1"));
    }

    @Test public void deleteFinishesTheJobWhenOnlyTheKeyIsLeft() throws Exception {
        PhotoArchive photos = photos();
        photos.put(ACCOUNT, "p1", TestSupport.randomBytes(100, 1), meta());
        assertTrue(photos.file(ACCOUNT, "p1").delete());
        assertTrue("a stray key is removed and reported", photos.delete(ACCOUNT, "p1"));
        assertFalse(vault.hasKey(PhotoArchive.namespace(ACCOUNT, "p1")));
    }

    @Test public void photosWrittenByEarlierReleasesStillOpen() throws Exception {
        String ns = PhotoArchive.namespace(ACCOUNT, "old");
        byte[] jpeg = TestSupport.randomBytes(2000, 6);
        JSONObject legacy = new JSONObject().put("image", B64.encode(jpeg)).put("metadata", meta());
        java.nio.file.Files.write(photos().file(ACCOUNT, "old").toPath(),
                vault.seal(ns, ns, legacy.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        PhotoArchive.Photo photo = photos().get(ACCOUNT, "old");
        assertArrayEquals(jpeg, photo.jpeg);
        assertEquals(-6.2, photo.metadata.getDouble("lat"), 0.0001);
        assertTrue(photos().delete(ACCOUNT, "old"));
    }

    @Test public void aPhotoFileCannotBePassedOffAsAnotherPhoto() throws Exception {
        PhotoArchive photos = photos();
        photos.put(ACCOUNT, "a", TestSupport.randomBytes(500, 1), meta());
        java.nio.file.Files.copy(photos.file(ACCOUNT, "a").toPath(), photos.file(ACCOUNT, "b").toPath());
        try {
            photos.get(ACCOUNT, "b");
            fail("different key and AAD");
        } catch (Vault.KeyMissingException | Vault.CorruptDataException expected) { /* rejected */ }
    }

    @Test public void removingADraftAlsoDeletesItsArchivedOriginalButNotOtherPhotos() throws Exception {
        PhotoArchive photos = photos();
        draft("d1", "pending", null, 0);
        photos.put(ACCOUNT, "d1", TestSupport.randomBytes(500, 1), meta());
        photos.put(ACCOUNT, "record_job9", TestSupport.randomBytes(500, 2), meta());
        assertTrue(DraftLifecycle.remove(store, photos, ACCOUNT, "d1"));
        assertNull(store.meta(ACCOUNT, "d1"));
        assertNull(photos.get(ACCOUNT, "d1"));
        assertNotNull("the stamped record copy is independent of the draft", photos.get(ACCOUNT, "record_job9"));
        assertFalse(DraftLifecycle.remove(store, photos, ACCOUNT, "d1"));
    }

    @Test public void aFailingPhotoDeleteNeverStopsTheDraftFromBeingRemoved() throws Exception {
        draft("d1", "pending", null, 0);
        PhotoArchive broken = new PhotoArchive(root, vault, new TestSupport.JvmFiles(), lock) {
            @Override boolean delete(String account, String photoId) throws Exception { throw new java.io.IOException("keystore busy"); }
        };
        assertTrue(DraftLifecycle.remove(store, broken, ACCOUNT, "d1"));
        assertNull(store.meta(ACCOUNT, "d1"));
    }

    @Test public void anEditedDraftDropsItsOldOriginalOnlyOnceTheNewOneIsArchived() throws Exception {
        PhotoArchive photos = photos();
        photos.put(ACCOUNT, "old", TestSupport.randomBytes(300, 1), meta());
        DraftLifecycle.afterReplace(photos, ACCOUNT, "old", "new");
        assertNotNull("new photo is not archived yet: keep the old one", photos.get(ACCOUNT, "old"));
        photos.put(ACCOUNT, "new", TestSupport.randomBytes(300, 2), meta());
        DraftLifecycle.afterReplace(photos, ACCOUNT, "old", "new");
        assertNull(photos.get(ACCOUNT, "old"));
        assertNotNull(photos.get(ACCOUNT, "new"));
    }

    @Test public void fieldsAreComparedByValueForRepeatedEnqueues() throws Exception {
        JSONObject a = new JSONObject().put("lat", "1").put("cropId", JSONObject.NULL);
        JSONObject b = new JSONObject().put("cropId", JSONObject.NULL).put("lat", "1");
        assertTrue(DraftLifecycle.sameFields(a, b));
        assertFalse(DraftLifecycle.sameFields(a, new JSONObject().put("lat", "2")));
        assertFalse(DraftLifecycle.sameFields(a, new JSONObject().put("lat", "1").put("cropId", "x")));
        assertFalse(DraftLifecycle.sameFields(a, null));
    }

    // ------------------------------------------------------------------ pending revoke

    private RevokeQueue revokes() { return new RevokeQueue(root, vault, new TestSupport.JvmFiles(), clock, lock); }

    @Test public void aLogoutThatCouldNotBeDeliveredIsKeptEncryptedAndDeletedAfterwards() throws Exception {
        RevokeQueue queue = revokes();
        String id = queue.add(ACCOUNT, "jk_session=SECRETTOKEN; jk_csrf=c", "c", clock.now() + 86_400_000L);
        assertEquals(java.util.Collections.singletonList(id), queue.ids(ACCOUNT));
        assertTrue(queue.ids("acct_two").isEmpty());
        for (File file : root.listFiles()) assertFalse(TestSupport.read(file).contains("SECRETTOKEN"));
        RevokeQueue.Entry entry = revokes().read(ACCOUNT, id);
        assertEquals("jk_session=SECRETTOKEN; jk_csrf=c", entry.cookie);
        assertEquals("c", entry.csrf);
        assertFalse(queue.expired(entry));
        queue.delete(ACCOUNT, id);
        assertTrue(queue.ids(ACCOUNT).isEmpty());
        assertNull(queue.read(ACCOUNT, id));
        assertFalse("its key is gone too", vault.hasKey(ACCOUNT + ":revoke:" + id));
        queue.delete(ACCOUNT, id);
    }

    @Test public void oldOrExpiredSessionsNeedNoRevoke() throws Exception {
        RevokeQueue queue = revokes();
        String id = queue.add(ACCOUNT, "c", "x", clock.now() + 1000);
        clock.advance(2000);
        assertTrue(queue.expired(queue.read(ACCOUNT, id)));
        String noExpiry = queue.add(ACCOUNT, "c", "x", 0);
        clock.advance(RevokeQueue.MAX_AGE_MS + 1);
        assertTrue(queue.expired(queue.read(ACCOUNT, noExpiry)));
    }

    @Test public void anUnreadableRevokeEntryIsDroppedInsteadOfLoopingForever() throws Exception {
        RevokeQueue queue = revokes();
        String id = queue.add(ACCOUNT, "c", "x", 0);
        vault.loseAllKeys();
        assertNull(queue.read(ACCOUNT, id));
        assertTrue(queue.ids(ACCOUNT).isEmpty());
    }

    @Test public void onlyTransientAnswersToTheLogoutAreRetried() {
        for (int status : new int[]{408, 425, 429, 500, 502, 503, 302}) assertTrue("" + status, RevokeQueue.shouldRetry(status));
        for (int status : new int[]{200, 204, 401, 403, 400, 404}) assertFalse("" + status, RevokeQueue.shouldRetry(status));
    }
}
