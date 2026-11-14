package jagake.bond.app;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import static jagake.bond.app.TestSupport.ACCOUNT;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/** Audit H-2: the single-blob outbox becomes one encrypted file per draft, losslessly and crash-safely. */
public class OutboxMigrationTest {
    private File root;
    private TestSupport.SoftwareVault vault;
    private TestSupport.Clock clock;

    @Before public void setUp() throws Exception {
        root = TestSupport.tempDir();
        vault = new TestSupport.SoftwareVault();
        clock = new TestSupport.Clock();
    }

    @After public void tearDown() { TestSupport.deleteTree(root); }

    private OutboxStore store(FileOps files) { return new OutboxStore(root, vault, files, clock, new Object()); }

    private OutboxStore store() { return store(new TestSupport.JvmFiles()); }

    private void assertMatchesSample(OutboxStore store, List<byte[]> images) throws Exception {
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(3, listing.rows.size());
        String[] ids = {"draft-aaa", "draft-bbb", "draft-ccc"};
        String[] statuses = {"pending", "submitted", "blocked"};
        for (int i = 0; i < 3; i++) {
            JSONObject row = listing.rows.get(i);
            assertEquals(ids[i], row.getString("clientRequestId"));
            assertEquals(statuses[i], row.getString("status"));
            assertEquals(1_799_000_000_000L + i, row.getLong("createdMs"));
            JSONObject fields = row.getJSONObject("fields");
            assertEquals("-6.2", fields.getString("lat"));
            assertEquals("Kebun Cengkeh — Maluku", fields.getString("locationName"));
            assertTrue("a null capture field stays null", fields.isNull("cropId"));
            assertFalse("the photo never goes into the index", row.has("imageBase64"));
            OutboxStore.Draft draft = store.readDraft(ACCOUNT, ids[i]);
            assertNotNull(draft);
            assertArrayEquals("photo " + ids[i], images.get(i), draft.image);
        }
        assertEquals("job_123", listing.rows.get(1).getString("jobId"));
        assertEquals("authentication_required", listing.rows.get(2).getString("error"));
        assertEquals(1_800_000_100_000L, listing.rows.get(2).getLong("nextAttemptAtMs"));
        assertEquals(0, listing.quarantined);
    }

    @Test public void migratesTheLegacyBlobWithoutLosingAnything() throws Exception {
        List<byte[]> images = new ArrayList<>();
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(images));
        OutboxStore store = store();
        assertMatchesSample(store, images);

        assertFalse("the legacy blob is no longer the live outbox", TestSupport.legacyBlobFile(root, ACCOUNT).exists());
        assertTrue("it is kept until the next successful start", store.backupFile(ACCOUNT).exists());
        File[] draftFiles = store.dir(ACCOUNT).listFiles((d, n) -> n.startsWith("d."));
        assertEquals(3, draftFiles.length);
        for (File file : store.dir(ACCOUNT).listFiles()) {
            String text = TestSupport.read(file);
            assertFalse("nothing readable on disk: " + file.getName(), text.contains("Kebun") || text.contains("draft-aaa") || text.contains("job_123"));
        }

        OutboxStore secondStart = store();
        assertMatchesSample(secondStart, images);
        assertFalse("the old copy is removed once the new store read fine on a later start", store.backupFile(ACCOUNT).exists());
    }

    private int countMigrationOperations() throws Exception {
        File dir = TestSupport.tempDir();
        try {
            TestSupport.SoftwareVault v = new TestSupport.SoftwareVault();
            TestSupport.writeLegacyBlob(dir, v, ACCOUNT, TestSupport.sampleLegacyRows(null));
            TestSupport.CrashingFiles counter = new TestSupport.CrashingFiles(0, false);
            new OutboxStore(dir, v, counter, clock, new Object()).list(ACCOUNT);
            return counter.operations;
        } finally { TestSupport.deleteTree(dir); }
    }

    @Test public void powerLossAtEveryStepOfTheMigrationNeverLosesADraft() throws Exception {
        int total = countMigrationOperations();
        assertTrue("migration performs several durable steps, saw " + total, total >= 6);
        int scenarios = 0;
        for (boolean torn : new boolean[]{false, true}) {
            for (int step = 1; step <= total; step++) {
                File dir = TestSupport.tempDir();
                try {
                    TestSupport.SoftwareVault v = new TestSupport.SoftwareVault();
                    List<byte[]> images = new ArrayList<>();
                    TestSupport.writeLegacyBlob(dir, v, ACCOUNT, TestSupport.sampleLegacyRows(images));
                    TestSupport.CrashingFiles crashing = new TestSupport.CrashingFiles(step, torn);
                    try {
                        new OutboxStore(dir, v, crashing, clock, new Object()).list(ACCOUNT);
                        fail("expected the simulated power loss at step " + step);
                    } catch (TestSupport.CrashingFiles.SimulatedCrash expected) { /* power cut */ }

                    OutboxStore probe = new OutboxStore(dir, v, new TestSupport.JvmFiles(), clock, new Object());
                    File legacy = TestSupport.legacyBlobFile(dir, ACCOUNT);
                    assertTrue("step " + step + (torn ? " torn" : "") + ": the data must still be on disk",
                            legacy.exists() || probe.backupFile(ACCOUNT).exists());

                    // New process after the power cut: everything is there, exactly once.
                    OutboxStore afterCut = new OutboxStore(dir, v, new TestSupport.JvmFiles(), clock, new Object());
                    assertSameAsSample(afterCut, images, "step " + step + (torn ? " torn" : ""));
                    // And once more: a repeated start is idempotent.
                    assertSameAsSample(new OutboxStore(dir, v, new TestSupport.JvmFiles(), clock, new Object()), images, "restart after step " + step);
                    scenarios++;
                } finally { TestSupport.deleteTree(dir); }
            }
        }
        assertEquals(total * 2, scenarios);
    }

    private void assertSameAsSample(OutboxStore store, List<byte[]> images, String why) throws Exception {
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(why, 3, listing.rows.size());
        String[] ids = {"draft-aaa", "draft-bbb", "draft-ccc"};
        for (int i = 0; i < 3; i++) {
            assertEquals(why, ids[i], listing.rows.get(i).getString("clientRequestId"));
            assertArrayEquals(why + " photo " + i, images.get(i), store.readDraft(ACCOUNT, ids[i]).image);
        }
        assertEquals(why, "job_123", listing.rows.get(1).getString("jobId"));
        assertEquals(why, 0, listing.quarantined);
    }

    @Test public void aMigrationThatCannotBeVerifiedLeavesTheLegacyOutboxUntouched() throws Exception {
        List<byte[]> images = new ArrayList<>();
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(images));
        byte[] before = Files.readAllBytes(TestSupport.legacyBlobFile(root, ACCOUNT).toPath());
        TestSupport.JvmFiles damaging = new TestSupport.JvmFiles() {
            @Override public void writeDurable(File target, byte[]... parts) throws java.io.IOException {
                super.writeDurable(target, parts);
                if (target.getName().startsWith("d.")) {
                    try (RandomAccessFile file = new RandomAccessFile(target, "rw")) {
                        file.seek(file.length() - 3);
                        int b = file.read();
                        file.seek(file.length() - 3);
                        file.write(b ^ 0x55);
                    }
                }
            }
        };
        try {
            store(damaging).list(ACCOUNT);
            fail("a verification failure must surface, not be swallowed");
        } catch (java.io.IOException expected) {
            assertTrue(expected.getMessage(), expected.getMessage().contains("verification"));
        }
        assertArrayEquals("legacy outbox untouched", before, Files.readAllBytes(TestSupport.legacyBlobFile(root, ACCOUNT).toPath()));
        assertFalse(new File(new File(root, StoreNames.fileKey(ACCOUNT) + ".outbox.d"), "index").exists());
        assertEquals("nothing quarantined", 0, store().list(ACCOUNT).quarantined);
        // A healthy start then completes the migration.
        OutboxStore healthy = store();
        assertMatchesSample(healthy, images);
    }

    @Test public void aCrashBetweenIndexAndBlobRenameIsFinishedOnTheNextStart() throws Exception {
        List<byte[]> images = new ArrayList<>();
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(images));
        OutboxStore first = store();
        first.list(ACCOUNT);
        // Put the legacy blob back: the state of a crash after the index became durable but before the rename.
        Files.copy(first.backupFile(ACCOUNT).toPath(), TestSupport.legacyBlobFile(root, ACCOUNT).toPath());
        Files.delete(first.backupFile(ACCOUNT).toPath());
        OutboxStore restarted = store();
        assertMatchesSample(restarted, images);
        assertFalse(TestSupport.legacyBlobFile(root, ACCOUNT).exists());
        assertTrue(restarted.backupFile(ACCOUNT).exists());
    }

    @Test public void strayTemporaryFilesAndOrphanDraftFilesAreSweptButIndexedDraftsAreNot() throws Exception {
        OutboxStore store = store();
        JSONObject fields = new JSONObject().put("lat", "1").put("lng", "2");
        store.add(ACCOUNT, "kept", fields, 5, "pending", TestSupport.randomBytes(900, 9));
        File dir = store.dir(ACCOUNT);
        Files.write(new File(dir, "d.jaga_orphan").toPath(), new byte[]{1, 2, 3});
        Files.write(new File(dir, "d.jaga_half.tmp").toPath(), new byte[]{1});
        Files.write(new File(dir, "index.tmp").toPath(), new byte[]{1});
        OutboxStore restarted = store();
        assertEquals(1, restarted.list(ACCOUNT).rows.size());
        assertFalse(new File(dir, "d.jaga_orphan").exists());
        assertFalse(new File(dir, "d.jaga_half.tmp").exists());
        assertFalse(new File(dir, "index.tmp").exists());
        assertNotNull(restarted.readDraft(ACCOUNT, "kept"));
    }

    @Test public void aLegacyBlobThatAppearsNextToAnExistingIndexIsMergedNotLost() throws Exception {
        // Downgrade then upgrade again: the old app wrote drafts into a fresh legacy blob.
        OutboxStore store = store();
        byte[] imageA = TestSupport.randomBytes(700, 11);
        byte[] imageB = TestSupport.randomBytes(800, 12);
        JSONObject fields = new JSONObject().put("lat", "1").put("lng", "2");
        store.add(ACCOUNT, "A", fields, 1, "pending", imageA);
        store.add(ACCOUNT, "B", fields, 2, "pending", imageB);
        store.update(ACCOUNT, "B", row -> { row.put("status", "failed").put("error", "http_400"); return true; });
        byte[] imageC = TestSupport.randomBytes(900, 13);
        List<JSONObject> legacy = new ArrayList<>();
        legacy.add(TestSupport.legacyRow("B", "pending", imageB, 2));
        legacy.add(TestSupport.legacyRow("C", "pending", imageC, 3));
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, legacy);

        OutboxStore restarted = store();
        OutboxStore.Listing listing = restarted.list(ACCOUNT);
        assertEquals(3, listing.rows.size());
        assertEquals("A", listing.rows.get(0).getString("clientRequestId"));
        assertEquals("B", listing.rows.get(1).getString("clientRequestId"));
        assertEquals("the current store wins for drafts it already knows", "failed", listing.rows.get(1).getString("status"));
        assertEquals("C", listing.rows.get(2).getString("clientRequestId"));
        assertArrayEquals(imageC, restarted.readDraft(ACCOUNT, "C").image);
        assertArrayEquals(imageB, restarted.readDraft(ACCOUNT, "B").image);
    }

    @Test public void aDraftFileDamagedByAnInterruptedRunIsRepairedFromTheLegacyBlob() throws Exception {
        List<byte[]> images = new ArrayList<>();
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(images));
        OutboxStore first = store();
        first.list(ACCOUNT);
        File draftFile = first.draftFile(ACCOUNT, "draft-aaa");
        Files.copy(first.backupFile(ACCOUNT).toPath(), TestSupport.legacyBlobFile(root, ACCOUNT).toPath());
        Files.delete(first.backupFile(ACCOUNT).toPath());
        Files.delete(draftFile.toPath());
        OutboxStore restarted = store();
        assertMatchesSample(restarted, images);
    }

    @Test public void anUndecodablePhotoIsKeptAsAFailedDraftInsteadOfBeingDropped() throws Exception {
        List<JSONObject> rows = new ArrayList<>();
        JSONObject bad = TestSupport.legacyRow("bad-one", "pending", TestSupport.randomBytes(300, 5), 10);
        bad.put("imageBase64", "A");
        rows.add(bad);
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, rows);
        OutboxStore store = store();
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(1, listing.rows.size());
        assertEquals("failed", listing.rows.get(0).getString("status"));
        assertEquals("image_unreadable", listing.rows.get(0).getString("error"));
        OutboxStore.Draft draft = store.readDraft(ACCOUNT, "bad-one");
        assertNull(draft.image);
        assertEquals("A", draft.rawBase64);
    }

    @Test public void aRowWithoutAnIdCannotBeIndexedSoTheBlobIsQuarantinedAfterTheRestAreMigrated() throws Exception {
        List<byte[]> images = new ArrayList<>();
        List<JSONObject> rows = TestSupport.sampleLegacyRows(images);
        rows.add(new JSONObject().put("accountId", ACCOUNT).put("status", "pending").put("imageBase64", "AAAA"));
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, rows);
        OutboxStore store = store();
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(3, listing.rows.size());
        assertEquals("the damaged blob is kept aside and reported", 1, listing.quarantined);
        assertTrue(listing.quarantinedApprox);
        assertFalse(store.backupFile(ACCOUNT).exists());
        assertFalse(TestSupport.legacyBlobFile(root, ACCOUNT).exists());
        String[] names = root.list((d, n) -> n.contains(".outbox.q.") && n.endsWith(".blob"));
        assertEquals(1, names.length);
    }

    @Test public void manyLargeDraftsMigrateWithOnePhotoInMemoryAtATime() throws Exception {
        List<JSONObject> rows = new ArrayList<>();
        List<byte[]> images = new ArrayList<>();
        for (int i = 0; i < 60; i++) {
            byte[] image = TestSupport.randomBytes(100_000, 100 + i);
            images.add(image);
            rows.add(TestSupport.legacyRow("bulk-" + i, "pending", image, 1000 + i));
        }
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, rows);
        OutboxStore store = store();
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(60, listing.rows.size());
        for (int i = 0; i < 60; i += 7) assertArrayEquals(images.get(i), store.readDraft(ACCOUNT, "bulk-" + i).image);
        // list() reads only the index: destroy every photo file and it still answers.
        for (File file : store.dir(ACCOUNT).listFiles((d, n) -> n.startsWith("d."))) assertTrue(file.delete());
        assertEquals(60, store().list(ACCOUNT).rows.size());
    }

    @Test public void emptyOrAbsentLegacyOutboxesNeedNoMigration() throws Exception {
        assertEquals(0, store().list(ACCOUNT).rows.size());
        TestSupport.writeLegacyBlob(root, vault, "acct_two", new ArrayList<>());
        assertEquals(0, store().list("acct_two").rows.size());
        assertFalse(TestSupport.legacyBlobFile(root, "acct_two").exists());
    }
}
