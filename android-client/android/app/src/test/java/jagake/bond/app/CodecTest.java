package jagake.bond.app;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Random;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

/** B64, StoreNames, JsonArraySplitter, Blob: the small building blocks under the store. */
public class CodecTest {
    @Test public void base64MatchesTheJdkForEveryLength() {
        Random random = new Random(5);
        for (int length = 0; length < 300; length++) {
            byte[] data = new byte[length];
            random.nextBytes(data);
            String expected = java.util.Base64.getEncoder().encodeToString(data);
            assertEquals(expected, B64.encode(data));
            assertArrayEquals(data, B64.decode(expected));
            assertEquals(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(data), B64.encodeUrl(data));
            assertArrayEquals("unpadded input is accepted", data, B64.decode(expected.replace("=", "")));
        }
        byte[] big = new byte[3_000_001];
        random.nextBytes(big);
        assertArrayEquals(big, B64.decode(B64.encode(big)));
    }

    @Test public void base64DecoderIsAsLenientAsTheAndroidOneForWhitespaceButRejectsImpossibleLengths() {
        assertArrayEquals("hello".getBytes(StandardCharsets.UTF_8), B64.decode("aGVs\nbG8=\r\n"));
        assertArrayEquals("hello".getBytes(StandardCharsets.UTF_8), B64.decode(" aGVsbG8 "));
        for (String bad : new String[]{"A", "AAAAA", "AAAA=AAAA"}) {
            try {
                B64.decode(bad);
                fail("must reject " + bad);
            } catch (IllegalArgumentException expected) { /* fine */ }
        }
        assertArrayEquals(new byte[0], B64.decode(""));
    }

    @Test public void fileNamesAreStableAcrossReleases() {
        // These names exist on farmers' phones: changing the derivation would orphan every session, draft and photo.
        assertEquals("jaga_R4CeRmyOEiJbqG5k0rohQC4RZNLWb05MemgKqKt3Gqs", StoreNames.fileKey("acct_1"));
        assertEquals("jaga_naJcq9JZh5jnTsS9kWMnUwxxN2sA-MpnO66Iyxm0k_c", StoreNames.fileKey("acct_1:outbox"));
        assertEquals(48, StoreNames.fileKey("anything").length());
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", StoreNames.sha256Hex(new byte[0]));
    }

    @Test public void jsonArraySplitterHandlesTrickyStringsAndNesting() throws Exception {
        String tricky = "{\"a\":\"he said \\\"]\\\" and {\\\\\",\"b\":[1,{\"c\":\"}\"}],\"d\":\"é—\"}";
        String json = " [ " + tricky + " , 42 , \"x,]\" , null , [ ] , {} ] ";
        JsonArraySplitter splitter = new JsonArraySplitter(json.getBytes(StandardCharsets.UTF_8));
        String[] expected = {tricky, "42", "\"x,]\"", "null", "[ ]", "{}"};
        for (String item : expected) {
            org.junit.Assert.assertTrue(splitter.hasNext());
            assertEquals(item, splitter.next());
        }
        org.junit.Assert.assertFalse(splitter.hasNext());
        org.junit.Assert.assertFalse(new JsonArraySplitter("[]".getBytes(StandardCharsets.UTF_8)).hasNext());
        assertEquals("aé", new org.json.JSONObject(new JsonArraySplitter("[{\"k\":\"aé\"}]".getBytes(StandardCharsets.UTF_8)).next()).getString("k"));
    }

    @Test public void jsonArraySplitterRejectsMalformedInput() {
        for (String bad : new String[]{"", "{}", "[1,", "[1 2]", "[\"abc]", "[{\"a\":1]", "[1,]", "[1] x", "[}"}) {
            try {
                JsonArraySplitter splitter = new JsonArraySplitter(bad.getBytes(StandardCharsets.UTF_8));
                while (splitter.hasNext()) splitter.next();
                fail("must reject: " + bad);
            } catch (IllegalArgumentException expected) { /* fine */ }
        }
    }

    // ------------------------------------------------------------------ Blob

    private static final String KEY = "acct:outbox";

    private java.io.File write(TestSupport.SoftwareVault vault, java.io.File dir, byte[] meta, byte[] payload) throws Exception {
        java.io.File file = new java.io.File(dir, "blob");
        Blob.write(new TestSupport.JvmFiles(), vault, file, KEY, "m-aad", "p-aad", meta, payload, 0, payload.length);
        return file;
    }

    @Test public void blobRoundTripsAndDetectsEveryKindOfDamage() throws Exception {
        java.io.File dir = TestSupport.tempDir();
        try {
            TestSupport.SoftwareVault vault = new TestSupport.SoftwareVault();
            byte[] meta = "{\"id\":\"x\"}".getBytes(StandardCharsets.UTF_8);
            byte[] payload = TestSupport.randomBytes(5000, 3);
            java.io.File file = write(vault, dir, meta, payload);
            org.junit.Assert.assertTrue(Blob.isContainer(file));
            assertArrayEquals(meta, Blob.readMeta(vault, file, KEY, "m-aad"));
            assertArrayEquals(payload, Blob.readPayload(vault, file, KEY, "p-aad"));

            // wrong AAD
            expectCorrupt(vault, file, "p-aad", "m-aad");
            // flipping a byte anywhere in the file is detected (header, either envelope)
            byte[] original = java.nio.file.Files.readAllBytes(file.toPath());
            for (int at = 0; at < original.length; at += 37) {
                byte[] damaged = original.clone();
                damaged[at] ^= 0x10;
                java.nio.file.Files.write(file.toPath(), damaged);
                try {
                    Blob.readMeta(vault, file, KEY, "m-aad");
                    Blob.readPayload(vault, file, KEY, "p-aad");
                    fail("damage at byte " + at + " went unnoticed");
                } catch (Vault.CorruptDataException expected) { /* detected */ }
            }
            // truncation and extension
            for (int cut : new int[]{1, 20, original.length / 2, original.length - 1}) {
                java.nio.file.Files.write(file.toPath(), java.util.Arrays.copyOf(original, cut));
                org.junit.Assert.assertFalse(Blob.isContainer(file));
                try { Blob.readPayload(vault, file, KEY, "p-aad"); fail("truncated file accepted"); } catch (Vault.CorruptDataException expected) { }
            }
            byte[] longer = java.util.Arrays.copyOf(original, original.length + 5);
            java.nio.file.Files.write(file.toPath(), longer);
            org.junit.Assert.assertFalse(Blob.isContainer(file));
            // other key
            java.nio.file.Files.write(file.toPath(), original);
            vault.loseAllKeys();
            try { Blob.readMeta(vault, file, KEY, "m-aad"); fail("key is gone"); } catch (Vault.KeyMissingException expected) { }
        } finally { TestSupport.deleteTree(dir); }
    }

    private static void expectCorrupt(TestSupport.SoftwareVault vault, java.io.File file, String metaAad, String payloadAad) throws Exception {
        try { Blob.readMeta(vault, file, KEY, metaAad); fail("wrong AAD accepted"); } catch (Vault.CorruptDataException expected) { }
        try { Blob.readPayload(vault, file, KEY, payloadAad); fail("wrong AAD accepted"); } catch (Vault.CorruptDataException expected) { }
    }

    @Test public void photoSizedPayloadsAndEmptyMetaWork() throws Exception {
        java.io.File dir = TestSupport.tempDir();
        try {
            TestSupport.SoftwareVault vault = new TestSupport.SoftwareVault();
            byte[] payload = TestSupport.randomBytes(12 * 1024 * 1024, 4);
            java.io.File file = write(vault, dir, new byte[0], payload);
            assertArrayEquals(payload, Blob.readPayload(vault, file, KEY, "p-aad"));
            assertEquals(0, Blob.readMeta(vault, file, KEY, "m-aad").length);
        } finally { TestSupport.deleteTree(dir); }
    }
}
