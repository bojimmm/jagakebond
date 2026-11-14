package jagake.bond.app;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
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

/** The per-draft outbox (audit H-2) and its quarantine (audit M-6). */
public class OutboxStoreTest {
    private File root;
    private TestSupport.SoftwareVault vault;
    private TestSupport.Clock clock;

    @Before public void setUp() throws Exception {
        root = TestSupport.tempDir();
        vault = new TestSupport.SoftwareVault();
        clock = new TestSupport.Clock();
    }

    @After public void tearDown() { TestSupport.deleteTree(root); }

    private OutboxStore store() { return new OutboxStore(root, vault, new TestSupport.JvmFiles(), clock, new Object()); }

    private static JSONObject fields(String lat) throws Exception {
        return new JSONObject().put("lat", lat).put("lng", "106.8").put("locationName", "Kebun").put("cropId", JSONObject.NULL);
    }

    private static void flipByte(File file, long position) throws Exception {
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            raf.seek(position);
            int b = raf.read();
            raf.seek(position);
            raf.write(b ^ 0x01);
        }
    }

    // ------------------------------------------------------------------ basic operations

    @Test public void addListReadUpdateAndRemoveAreOneFilePerDraft() throws Exception {
        OutboxStore store = store();
        byte[] first = TestSupport.randomBytes(3000, 1);
        byte[] second = TestSupport.randomBytes(4000, 2);
        store.add(ACCOUNT, "one", fields("-6.2"), 10, "pending", first);
        store.add(ACCOUNT, "two", fields("-6.3"), 20, "pending", second);

        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(2, listing.rows.size());
        assertEquals("one", listing.rows.get(0).getString("clientRequestId"));
        assertEquals(3000, listing.rows.get(0).getInt("imgBytes"));
        assertEquals(StoreNames.sha256Hex(first), listing.rows.get(0).getString("imgSha"));
        assertArrayEquals(first, store.readDraft(ACCOUNT, "one").image);
        assertArrayEquals(second, store.readDraft(ACCOUNT, "two").image);
        assertEquals(2, store.dir(ACCOUNT).listFiles((d, n) -> n.startsWith("d.")).length);

        assertTrue(store.update(ACCOUNT, "one", row -> { row.put("status", "uploading"); return true; }));
        assertFalse(store.update(ACCOUNT, "missing", row -> true));
        assertEquals("uploading", store.meta(ACCOUNT, "one").getString("status"));
        assertEquals("pending", store.meta(ACCOUNT, "two").getString("status"));

        assertTrue(store.remove(ACCOUNT, "one"));
        assertFalse("removing twice is harmless", store.remove(ACCOUNT, "one"));
        assertNull(store.readDraft(ACCOUNT, "one"));
        assertEquals(1, store.dir(ACCOUNT).listFiles((d, n) -> n.startsWith("d.")).length);
        assertEquals(1, store().list(ACCOUNT).rows.size());
    }

    @Test public void addingTheSameDraftTwiceIsRefused() throws Exception {
        OutboxStore store = store();
        store.add(ACCOUNT, "dup", fields("1"), 1, "pending", TestSupport.randomBytes(100, 1));
        try {
            store.add(ACCOUNT, "dup", fields("1"), 1, "pending", TestSupport.randomBytes(100, 2));
            fail("an existing clientRequestId must not be overwritten");
        } catch (IllegalStateException expected) { /* fine */ }
    }

    @Test public void listReadsOnlyTheIndexNeverThePhotos() throws Exception {
        OutboxStore store = store();
        for (int i = 0; i < 20; i++) store.add(ACCOUNT, "d" + i, fields("1"), i, "pending", TestSupport.randomBytes(50_000, i));
        int opensBefore = vault.openCount;
        OutboxStore restarted = store();
        OutboxStore.Listing listing = restarted.list(ACCOUNT);
        assertEquals(20, listing.rows.size());
        int firstList = vault.openCount - opensBefore;
        assertTrue("start-up reads the index (and nothing of the 20 photos), opens=" + firstList, firstList >= 1 && firstList <= 2);
        restarted.list(ACCOUNT);
        assertEquals("every further list is exactly one index read", opensBefore + firstList + 1, vault.openCount);
    }

    @Test public void replaceMovesTheDraftToANewIdKeepingItsPhotoAndCreationTime() throws Exception {
        OutboxStore store = store();
        byte[] image = TestSupport.randomBytes(2500, 4);
        store.add(ACCOUNT, "old", fields("1"), 77, "failed", image);
        store.update(ACCOUNT, "old", row -> { row.put("error", "http_400").put("jobId", "job_9"); return true; });
        store.replace(ACCOUNT, "old", "new", fields("2"), "editing");
        assertNull(store.meta(ACCOUNT, "old"));
        JSONObject moved = store.meta(ACCOUNT, "new");
        assertEquals("editing", moved.getString("status"));
        assertEquals(77, moved.getLong("createdMs"));
        assertEquals("2", moved.getJSONObject("fields").getString("lat"));
        assertFalse("error and job id do not follow the edit", moved.has("error") || moved.has("jobId"));
        assertArrayEquals(image, store.readDraft(ACCOUNT, "new").image);
        assertFalse(store.draftFile(ACCOUNT, "old").exists());
        assertEquals("the edited copy is last, as before", "new", store.list(ACCOUNT).rows.get(0).getString("clientRequestId"));
    }

    @Test public void batchEditWritesTheIndexOnce() throws Exception {
        OutboxStore store = store();
        for (int i = 0; i < 5; i++) store.add(ACCOUNT, "d" + i, fields("1"), i, "pending", TestSupport.randomBytes(100, i));
        int seals = vault.sealCount;
        assertTrue(store.edit(ACCOUNT, rows -> { for (JSONObject r : rows) r.put("status", "blocked"); return true; }));
        assertEquals(seals + 1, vault.sealCount);
        assertFalse(store.edit(ACCOUNT, rows -> false));
        assertEquals(seals + 1, vault.sealCount);
    }

    @Test public void accountsAreSeparate() throws Exception {
        OutboxStore store = store();
        store.add("acct_a", "x", fields("1"), 1, "pending", TestSupport.randomBytes(100, 1));
        assertEquals(0, store.list("acct_b").rows.size());
        assertNull(store.readDraft("acct_b", "x"));
        assertFalse(store.dir("acct_a").equals(store.dir("acct_b")));
    }

    // ------------------------------------------------------------------ quarantine (M-6)

    @Test public void aLostKeyQuarantinesTheLegacyBlobAndAFreshOutboxStartsAtOnce() throws Exception {
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(null));
        byte[] before = Files.readAllBytes(TestSupport.legacyBlobFile(root, ACCOUNT).toPath());
        vault.loseAllKeys();

        OutboxStore store = store();
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(0, listing.rows.size());
        assertEquals(1, listing.quarantined);
        assertTrue("the size of an unreadable blob is unknowable", listing.quarantinedApprox);
        File[] kept = root.listFiles((d, n) -> n.contains(".outbox.q.") && n.endsWith(".blob"));
        assertEquals(1, kept.length);
        assertArrayEquals("the bytes are kept, only renamed", before, Files.readAllBytes(kept[0].toPath()));
        assertFalse(TestSupport.legacyBlobFile(root, ACCOUNT).exists());

        // Capture works again immediately.
        byte[] image = TestSupport.randomBytes(1000, 3);
        store.add(ACCOUNT, "fresh", fields("1"), 5, "pending", image);
        assertArrayEquals(image, store().readDraft(ACCOUNT, "fresh").image);
    }

    @Test public void aCorruptLegacyBlobIsQuarantinedToo() throws Exception {
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(null));
        File blob = TestSupport.legacyBlobFile(root, ACCOUNT);
        flipByte(blob, blob.length() / 2);
        OutboxStore.Listing listing = store().list(ACCOUNT);
        assertEquals(0, listing.rows.size());
        assertEquals(1, listing.quarantined);
    }

    @Test public void aTransientKeystoreFailureNeverQuarantinesOrChangesAnything() throws Exception {
        List<byte[]> images = new ArrayList<>();
        TestSupport.writeLegacyBlob(root, vault, ACCOUNT, TestSupport.sampleLegacyRows(images));
        byte[] before = Files.readAllBytes(TestSupport.legacyBlobFile(root, ACCOUNT).toPath());
        vault.transientFailure = new IOException("keystore busy");
        OutboxStore store = store();
        try {
            store.list(ACCOUNT);
            fail("a transient failure must be reported, not hidden");
        } catch (IOException expected) {
            assertEquals("keystore busy", expected.getMessage());
        }
        assertArrayEquals(before, Files.readAllBytes(TestSupport.legacyBlobFile(root, ACCOUNT).toPath()));
        assertEquals(0, root.listFiles((d, n) -> n.contains(".q.")).length);

        vault.transientFailure = null;
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals("the same store instance recovers once the keystore answers", 3, listing.rows.size());
        assertEquals(0, listing.quarantined);
    }

    @Test public void aLostKeyQuarantinesTheDraftDirectoryWithAnExactCount() throws Exception {
        OutboxStore store = store();
        store.add(ACCOUNT, "a", fields("1"), 1, "pending", TestSupport.randomBytes(500, 1));
        store.add(ACCOUNT, "b", fields("1"), 2, "pending", TestSupport.randomBytes(500, 2));
        store.add(ACCOUNT, "c", fields("1"), 3, "submitted", TestSupport.randomBytes(500, 3));
        vault.loseAllKeys();

        OutboxStore restarted = store();
        OutboxStore.Listing listing = restarted.list(ACCOUNT);
        assertEquals(0, listing.rows.size());
        assertEquals(3, listing.quarantined);
        assertFalse(listing.quarantinedApprox);
        assertEquals(1, root.listFiles((d, n) -> n.contains(".outbox.q.") && !n.endsWith(".blob")).length);
        assertFalse(restarted.dir(ACCOUNT).exists());
        restarted.add(ACCOUNT, "next", fields("1"), 4, "pending", TestSupport.randomBytes(500, 4));
        assertEquals(1, store().list(ACCOUNT).rows.size());
        assertEquals(3, store().list(ACCOUNT).quarantined);
    }

    @Test public void acknowledgingTheNoticeResetsTheCountButKeepsTheFiles() throws Exception {
        OutboxStore store = store();
        store.add(ACCOUNT, "a", fields("1"), 1, "pending", TestSupport.randomBytes(500, 1));
        store.add(ACCOUNT, "b", fields("1"), 2, "pending", TestSupport.randomBytes(500, 2));
        vault.loseAllKeys();
        OutboxStore restarted = store();
        assertEquals(2, restarted.list(ACCOUNT).quarantined);
        restarted.acknowledgeQuarantine(ACCOUNT);
        assertEquals(0, restarted.list(ACCOUNT).quarantined);
        assertEquals(1, root.listFiles((d, n) -> n.contains(".outbox.q.")).length);
        // A later loss is counted again.
        restarted.add(ACCOUNT, "c", fields("1"), 3, "pending", TestSupport.randomBytes(500, 3));
        vault.loseAllKeys();
        OutboxStore third = store();
        assertEquals(1, third.list(ACCOUNT).quarantined);
    }

    @Test public void aKeyLostWhileTheAppRunsIsHealedOnTheNextCall() throws Exception {
        OutboxStore store = store();
        store.add(ACCOUNT, "a", fields("1"), 1, "pending", TestSupport.randomBytes(500, 1));
        vault.loseAllKeys();
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals(0, listing.rows.size());
        assertEquals(1, listing.quarantined);
        store.add(ACCOUNT, "b", fields("1"), 2, "pending", TestSupport.randomBytes(500, 2));
        assertEquals(1, store.list(ACCOUNT).rows.size());
    }

    @Test public void aCorruptIndexIsRebuiltFromTheSelfDescribingDraftFiles() throws Exception {
        OutboxStore store = store();
        byte[] imageA = TestSupport.randomBytes(900, 1);
        byte[] imageB = TestSupport.randomBytes(1100, 2);
        store.add(ACCOUNT, "a", fields("1"), 10, "failed", imageA);
        store.add(ACCOUNT, "b", fields("2"), 20, "submitted", imageB);
        File index = new File(store.dir(ACCOUNT), "index");
        flipByte(index, index.length() - 5);

        OutboxStore restarted = store();
        OutboxStore.Listing listing = restarted.list(ACCOUNT);
        assertEquals(2, listing.rows.size());
        assertEquals("a", listing.rows.get(0).getString("clientRequestId"));
        assertEquals("pending", listing.rows.get(0).getString("status"));
        assertEquals("2", listing.rows.get(1).getJSONObject("fields").getString("lat"));
        assertEquals(0, listing.quarantined);
        assertArrayEquals(imageA, restarted.readDraft(ACCOUNT, "a").image);
        assertArrayEquals(imageB, restarted.readDraft(ACCOUNT, "b").image);
        assertEquals("the rebuilt index is durable", 2, store().list(ACCOUNT).rows.size());
    }

    @Test public void aCorruptDraftFileIsSetAsideAndTheDraftShowsUpAsMissing() throws Exception {
        OutboxStore store = store();
        store.add(ACCOUNT, "a", fields("1"), 10, "pending", TestSupport.randomBytes(900, 1));
        store.add(ACCOUNT, "b", fields("1"), 20, "pending", TestSupport.randomBytes(900, 2));
        File file = store.draftFile(ACCOUNT, "a");
        flipByte(file, file.length() - 4);

        try {
            store.readDraft(ACCOUNT, "a");
            fail("expected an unreadable-photo error");
        } catch (OutboxStore.PayloadException e) {
            assertFalse(e.missing);
        }
        assertFalse(file.exists());
        assertEquals(1, store.dir(ACCOUNT).listFiles((d, n) -> n.startsWith("bad.")).length);
        OutboxStore.Listing listing = store.list(ACCOUNT);
        assertEquals("the row stays visible so the farmer can discard it", 2, listing.rows.size());
        assertEquals(1, listing.quarantined);
        try {
            store.readDraft(ACCOUNT, "a");
            fail("second read: file is gone");
        } catch (OutboxStore.PayloadException e) {
            assertTrue(e.missing);
        }
        assertNotNull(store.readDraft(ACCOUNT, "b"));
    }

    @Test public void aDraftFileSwappedBetweenDraftsIsRejected() throws Exception {
        OutboxStore store = store();
        store.add(ACCOUNT, "a", fields("1"), 10, "pending", TestSupport.randomBytes(900, 1));
        store.add(ACCOUNT, "b", fields("1"), 20, "pending", TestSupport.randomBytes(900, 2));
        Files.copy(store.draftFile(ACCOUNT, "a").toPath(), store.draftFile(ACCOUNT, "b").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        try {
            store.readDraft(ACCOUNT, "b");
            fail("the payload is bound to its draft id");
        } catch (OutboxStore.PayloadException e) {
            assertFalse(e.missing);
        }
    }
}
