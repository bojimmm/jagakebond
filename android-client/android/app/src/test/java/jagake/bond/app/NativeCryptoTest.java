package jagake.bond.app;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class NativeCryptoTest {
    private SecretKey key() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        return generator.generateKey();
    }

    @Test public void roundTripsWithFreshRandomIv() throws Exception {
        SecretKey key = key();
        byte[] plaintext = "private offline session".getBytes(StandardCharsets.UTF_8);
        byte[] first = NativeCrypto.encrypt(key, "acct:session", plaintext);
        byte[] second = NativeCrypto.encrypt(key, "acct:session", plaintext);
        assertEquals(12 + plaintext.length + 16, first.length);
        assertArrayEquals(plaintext, NativeCrypto.decrypt(key, "acct:session", first));
        assertNotEquals(java.util.Arrays.toString(first), java.util.Arrays.toString(second));
    }

    @Test public void rejectsTamperingWrongAadAndTruncation() throws Exception {
        SecretKey key = key();
        byte[] envelope = NativeCrypto.encrypt(key, "acct:outbox", new byte[] {1, 2, 3});
        envelope[envelope.length - 1] ^= 1;
        assertCryptoFailure(key, "acct:outbox", envelope);
        byte[] valid = NativeCrypto.encrypt(key, "acct:outbox", new byte[] {1, 2, 3});
        assertCryptoFailure(key, "other:outbox", valid);
        assertCryptoFailure(key(), "acct:outbox", valid);
        assertCryptoFailure(key, "acct:outbox", new byte[27]);
    }

    @Test public void nativeStoreKeepsAndroidKeystoreAndDurableWriteContracts() throws Exception {
        String source = new String(Files.readAllBytes(java.nio.file.Paths.get("src/main/java/jagake/bond/app/NativeStore.java")), StandardCharsets.UTF_8);
        assertTrue(source.contains(".setKeySize(256)"));
        assertTrue(source.contains("key(fileKey(namespace), false)"));
        assertTrue(source.contains(".setRandomizedEncryptionRequired(true)"));
        assertTrue(!source.contains("GCMParameterSpec"));
        assertTrue(!source.contains("SecureRandom"));
        // Every encrypted file (session, outbox index, drafts, photos, revoke tokens) is written through OsFiles.
        assertTrue(source.contains("FILES.writeDurable("));
        String files = new String(Files.readAllBytes(java.nio.file.Paths.get("src/main/java/jagake/bond/app/OsFiles.java")), StandardCharsets.UTF_8);
        assertTrue(files.contains("Os.rename("));
        assertTrue(files.contains("Os.fsync(descriptor)"));
        assertTrue(files.contains("Os.chmod(temp.getAbsolutePath(), 0600)"));
        assertTrue(files.contains("out.getFD().sync()"));
        String crypto = new String(Files.readAllBytes(java.nio.file.Paths.get("src/main/java/jagake/bond/app/NativeCrypto.java")), StandardCharsets.UTF_8);
        assertTrue(crypto.contains("cipher.init(Cipher.ENCRYPT_MODE, key)"));
        assertTrue(crypto.contains("cipher.getIV()"));
        assertTrue(crypto.contains("iv.length != IV_BYTES"));
    }

    @Test public void largeEnvelopesRoundTripWithOffsetsAndAuthenticateTheNamespace() throws Exception {
        SecretKey key = key();
        byte[] data = new byte[2_000_000];
        new java.util.Random(1).nextBytes(data);
        byte[] envelope = NativeCrypto.encrypt(key, "ns", data, 1000, 1_500_000);
        assertEquals(12 + 1_500_000 + 16, envelope.length);
        assertArrayEquals(java.util.Arrays.copyOfRange(data, 1000, 1_501_000), NativeCrypto.decrypt(key, "ns", envelope));
        try {
            NativeCrypto.decrypt(key, "other", envelope);
            fail("namespace is authenticated");
        } catch (Vault.CorruptDataException expected) { /* tamper/AAD failures are reported as corrupt data */ }
    }

    private static void assertCryptoFailure(SecretKey key, String namespace, byte[] envelope) throws Exception {
        try {
            NativeCrypto.decrypt(key, namespace, envelope);
            fail("Expected authentication or format failure");
        } catch (java.io.IOException | javax.crypto.AEADBadTagException expected) {
            // Expected: reject truncated payload or invalid GCM authentication tag.
        } catch (java.security.GeneralSecurityException expected) {
            // Provider may wrap authentication failures in a general security exception.
        }
    }
}
