package jagake.bond.app;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.ShortBufferException;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES-GCM envelope codec. Unit tests use software keys; Android Keystore needs device verification. */
final class NativeCrypto {
    static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private NativeCrypto() {}

    static byte[] encrypt(SecretKey key, String namespace, byte[] plaintext) throws Exception {
        return encrypt(key, namespace, plaintext, 0, plaintext.length);
    }

    /** IV | ciphertext | tag. Built in a single allocation so a large photo is not copied twice. */
    static byte[] encrypt(SecretKey key, String namespace, byte[] plaintext, int offset, int length) throws Exception {
        try {
            return encryptIntoEnvelope(key, namespace, plaintext, offset, length);
        } catch (ShortBufferException providerQuirk) {
            return encryptThenCopy(key, namespace, plaintext, offset, length);
        }
    }

    private static byte[] encryptIntoEnvelope(SecretKey key, String namespace, byte[] plaintext, int offset, int length) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_BYTES) throw new java.security.GeneralSecurityException("Provider returned an invalid GCM IV");
        cipher.updateAAD(namespace.getBytes(StandardCharsets.UTF_8));
        byte[] envelope = new byte[IV_BYTES + cipher.getOutputSize(length)];
        System.arraycopy(iv, 0, envelope, 0, IV_BYTES);
        int written = cipher.doFinal(plaintext, offset, length, envelope, IV_BYTES);
        return written == envelope.length - IV_BYTES ? envelope : Arrays.copyOf(envelope, IV_BYTES + written);
    }

    private static byte[] encryptThenCopy(SecretKey key, String namespace, byte[] plaintext, int offset, int length) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_BYTES) throw new java.security.GeneralSecurityException("Provider returned an invalid GCM IV");
        cipher.updateAAD(namespace.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(plaintext, offset, length);
        byte[] envelope = Arrays.copyOf(iv, iv.length + ciphertext.length);
        System.arraycopy(ciphertext, 0, envelope, iv.length, ciphertext.length);
        return envelope;
    }

    /**
     * @throws Vault.CorruptDataException when the envelope is truncated or fails authentication (wrong key material,
     *         wrong namespace or tampered bytes); other exceptions come from the provider and are not proof of corruption.
     */
    static byte[] decrypt(SecretKey key, String namespace, byte[] envelope) throws Exception {
        if (envelope == null || envelope.length < IV_BYTES + TAG_BITS / 8)
            throw new Vault.CorruptDataException("Encrypted data is truncated");
        byte[] iv = Arrays.copyOfRange(envelope, 0, IV_BYTES);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD(namespace.getBytes(StandardCharsets.UTF_8));
        try {
            return cipher.doFinal(envelope, IV_BYTES, envelope.length - IV_BYTES);
        } catch (AEADBadTagException e) {
            throw new Vault.CorruptDataException("Encrypted data failed authentication", e);
        }
    }
}
