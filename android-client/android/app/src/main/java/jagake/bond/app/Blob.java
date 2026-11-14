package jagake.bond.app;

import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/**
 * Two-segment encrypted container used for draft and photo files (release 0.2.2.0).
 *
 * <pre>
 *   "JKB2" | u32 metaLen | u32 payloadLen | metaEnvelope | payloadEnvelope
 * </pre>
 *
 * Each envelope is an independent AES-GCM seal (IV | ciphertext | tag) with its own AAD, so the small metadata
 * can be read without touching (or decrypting) the photo, and the photo is never copied into a JSON string.
 * The header lengths must add up to the exact file size; a truncated or extended file is rejected as corrupt.
 */
final class Blob {
    static final int HEADER = 12;
    private static final int MIN_ENVELOPE = 12 + 16;
    private static final byte[] MAGIC = {'J', 'K', 'B', '2'};

    private Blob() { }

    private static final class Header {
        final int metaLength;
        final int payloadLength;

        Header(int metaLength, int payloadLength) {
            this.metaLength = metaLength;
            this.payloadLength = payloadLength;
        }
    }

    /** True when the file starts like a v2 container and its declared lengths match its size. */
    static boolean isContainer(File file) {
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            return readHeader(in) != null;
        } catch (IOException e) {
            return false;
        }
    }

    private static Header readHeader(RandomAccessFile in) throws IOException {
        long size = in.length();
        if (size < HEADER) return null;
        byte[] header = new byte[HEADER];
        in.seek(0);
        in.readFully(header);
        for (int i = 0; i < MAGIC.length; i++) if (header[i] != MAGIC[i]) return null;
        long meta = u32(header, 4);
        long payload = u32(header, 8);
        if (meta < MIN_ENVELOPE || payload < MIN_ENVELOPE || HEADER + meta + payload != size) return null;
        return new Header((int) meta, (int) payload);
    }

    static void write(FileOps files, Vault vault, File target, String keyName, String aadMeta, String aadPayload,
                      byte[] meta, byte[] payload, int payloadOff, int payloadLen) throws Exception {
        byte[] metaEnvelope = vault.seal(keyName, aadMeta, meta, 0, meta.length);
        byte[] payloadEnvelope = vault.seal(keyName, aadPayload, payload, payloadOff, payloadLen);
        byte[] header = new byte[HEADER];
        System.arraycopy(MAGIC, 0, header, 0, MAGIC.length);
        putU32(header, 4, metaEnvelope.length);
        putU32(header, 8, payloadEnvelope.length);
        files.writeDurable(target, header, metaEnvelope, payloadEnvelope);
    }

    static byte[] readMeta(Vault vault, File file, String keyName, String aadMeta) throws Exception {
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            Header header = require(in);
            byte[] envelope = new byte[header.metaLength];
            in.seek(HEADER);
            in.readFully(envelope);
            return vault.open(keyName, aadMeta, envelope);
        } catch (EOFException e) {
            throw new Vault.CorruptDataException("Container ended early", e);
        }
    }

    static byte[] readPayload(Vault vault, File file, String keyName, String aadPayload) throws Exception {
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            Header header = require(in);
            byte[] envelope = new byte[header.payloadLength];
            in.seek(HEADER + (long) header.metaLength);
            in.readFully(envelope);
            return vault.open(keyName, aadPayload, envelope);
        } catch (EOFException e) {
            throw new Vault.CorruptDataException("Container ended early", e);
        }
    }

    private static Header require(RandomAccessFile in) throws IOException {
        Header header = readHeader(in);
        if (header == null) throw new Vault.CorruptDataException("Not a valid encrypted container");
        return header;
    }

    private static long u32(byte[] b, int at) {
        return ((long) (b[at] & 255) << 24) | ((b[at + 1] & 255) << 16) | ((b[at + 2] & 255) << 8) | (b[at + 3] & 255);
    }

    private static void putU32(byte[] b, int at, int value) {
        b[at] = (byte) (value >>> 24);
        b[at + 1] = (byte) (value >>> 16);
        b[at + 2] = (byte) (value >>> 8);
        b[at + 3] = (byte) value;
    }
}
