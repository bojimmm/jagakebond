package jagake.bond.app;

import java.util.Arrays;

/**
 * Dependency-free Base64 (RFC 4648) that works on API 24 and in plain JVM unit tests
 * ({@code android.util.Base64} is not available there and {@code java.util.Base64} needs API 26).
 *
 * <p>The decoder is as lenient as the Android decoder the app used before: characters outside the alphabet
 * (line breaks, spaces) are skipped and padding is optional. It still refuses an impossible length.
 */
final class B64 {
    private static final char[] STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
    private static final char[] URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();
    private static final byte[] DECODE = new byte[128];

    static {
        Arrays.fill(DECODE, (byte) -1);
        for (int i = 0; i < 64; i++) DECODE[STANDARD[i]] = (byte) i;
    }

    private B64() { }

    static String encode(byte[] data) { return encode(data, 0, data.length, false, true); }

    static String encode(byte[] data, int off, int len) { return encode(data, off, len, false, true); }

    /** URL-safe alphabet without padding (used for file and Keystore names). */
    static String encodeUrl(byte[] data) { return encode(data, 0, data.length, true, false); }

    private static String encode(byte[] data, int off, int len, boolean url, boolean pad) {
        char[] alphabet = url ? URL_SAFE : STANDARD;
        int full = len / 3;
        int rest = len - full * 3;
        char[] out = new char[full * 4 + (rest == 0 ? 0 : pad ? 4 : rest + 1)];
        int o = 0;
        int i = off;
        for (int n = 0; n < full; n++) {
            int v = (data[i] & 255) << 16 | (data[i + 1] & 255) << 8 | (data[i + 2] & 255);
            i += 3;
            out[o++] = alphabet[v >>> 18];
            out[o++] = alphabet[(v >>> 12) & 63];
            out[o++] = alphabet[(v >>> 6) & 63];
            out[o++] = alphabet[v & 63];
        }
        if (rest == 1) {
            int v = (data[i] & 255) << 16;
            out[o++] = alphabet[v >>> 18];
            out[o++] = alphabet[(v >>> 12) & 63];
            if (pad) { out[o++] = '='; out[o++] = '='; }
        } else if (rest == 2) {
            int v = (data[i] & 255) << 16 | (data[i + 1] & 255) << 8;
            out[o++] = alphabet[v >>> 18];
            out[o++] = alphabet[(v >>> 12) & 63];
            out[o++] = alphabet[(v >>> 6) & 63];
            if (pad) out[o++] = '=';
        }
        return new String(out, 0, o);
    }

    /** @throws IllegalArgumentException when the text cannot be a Base64 encoding of whole bytes. */
    static byte[] decode(CharSequence text) {
        int length = text.length();
        int end = length;
        int valid = 0;
        for (int i = 0; i < length; i++) {
            char c = text.charAt(i);
            if (c == '=') { end = i; break; }
            if (c < 128 && DECODE[c] >= 0) valid++;
        }
        for (int i = end; i < length; i++) {
            char c = text.charAt(i);
            if (c != '=' && c < 128 && DECODE[c] >= 0) throw new IllegalArgumentException("Base64 data after padding");
        }
        if (valid % 4 == 1) throw new IllegalArgumentException("Invalid Base64 length");
        byte[] out = new byte[valid / 4 * 3 + (valid % 4 == 0 ? 0 : valid % 4 - 1)];
        int accumulator = 0;
        int bits = 0;
        int o = 0;
        for (int i = 0; i < end; i++) {
            char c = text.charAt(i);
            int d = c < 128 ? DECODE[c] : -1;
            if (d < 0) continue;
            accumulator = (accumulator << 6) | d;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (accumulator >> bits);
                accumulator &= (1 << bits) - 1;
            }
        }
        return out;
    }
}
