package jagake.bond.app;

import java.io.IOException;

/**
 * Authenticated-encryption boundary. Production uses the Android Keystore ({@link NativeStore.KeystoreVault});
 * JVM tests use a software key so the store, the migration and the worker can be tested without a device.
 *
 * <p>Failure model of {@link #open}: {@link KeyMissingException} means the key is definitively gone,
 * {@link CorruptDataException} means the ciphertext failed authentication or is structurally broken.
 * Every other exception is treated as transient by callers: stored data must never be quarantined or deleted for it.
 */
interface Vault {
    byte[] seal(String keyName, String aad, byte[] plain, int off, int len) throws Exception;

    byte[] open(String keyName, String aad, byte[] sealed) throws Exception;

    /** @return true when a key existed and was removed; idempotent. */
    boolean deleteKey(String keyName) throws Exception;

    boolean hasKey(String keyName) throws Exception;

    default byte[] seal(String keyName, String aad, byte[] plain) throws Exception {
        return seal(keyName, aad, plain, 0, plain.length);
    }

    final class KeyMissingException extends IOException {
        KeyMissingException(String message) { super(message); }
    }

    final class CorruptDataException extends IOException {
        CorruptDataException(String message) { super(message); }

        CorruptDataException(String message, Throwable cause) { super(message, cause); }
    }
}
