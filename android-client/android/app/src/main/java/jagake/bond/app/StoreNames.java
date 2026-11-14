package jagake.bond.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Stable, filesystem- and Keystore-safe names. The derivation must never change: existing installs rely on it. */
final class StoreNames {
    static final String PREFIX = "jaga_";

    private StoreNames() { }

    /** {@code jaga_} + URL-safe unpadded Base64 of SHA-256(value). */
    static String fileKey(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            return PREFIX + B64.encodeUrl(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required", e);
        }
    }

    static String sha256Hex(byte[] data, int off, int len) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(data, off, len);
            byte[] hash = digest.digest();
            char[] hex = new char[hash.length * 2];
            for (int i = 0; i < hash.length; i++) {
                hex[i * 2] = Character.forDigit((hash[i] >> 4) & 15, 16);
                hex[i * 2 + 1] = Character.forDigit(hash[i] & 15, 16);
            }
            return new String(hex);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required", e);
        }
    }

    static String sha256Hex(byte[] data) { return sha256Hex(data, 0, data.length); }
}
