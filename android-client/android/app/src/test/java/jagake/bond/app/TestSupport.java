package jagake.bond.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** Shared JVM test doubles: software-key vault, java.nio file operations, crash injection, legacy-blob builder. */
final class TestSupport {
    private TestSupport() { }

    static final String ACCOUNT = "acct_one";

    static File tempDir() throws IOException {
        File dir = Files.createTempDirectory("jk-and-").toFile();
        dir.deleteOnExit();
        return dir;
    }

    static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    static byte[] randomBytes(int length, long seed) {
        byte[] bytes = new byte[length];
        new java.util.Random(seed).nextBytes(bytes);
        if (length >= 2) { bytes[0] = (byte) 0xFF; bytes[1] = (byte) 0xD8; }
        return bytes;
    }

    static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.ISO_8859_1);
    }

    static final class Clock implements OutboxStore.Clock {
        long now = 1_800_000_000_000L;

        @Override public long now() { return now; }

        void advance(long ms) { now += ms; }
    }

    /** AES-GCM with software keys: the same envelope code as production, keys held in memory. */
    static final class SoftwareVault implements Vault {
        private final Map<String, SecretKey> keys = new HashMap<>();
        /** When set, every seal/open throws it: a transient provider failure, not proof of anything. */
        IOException transientFailure;
        int sealCount;
        int openCount;

        private SecretKey key(String name, boolean create) throws Exception {
            SecretKey key = keys.get(name);
            if (key != null) return key;
            if (!create) throw new KeyMissingException("no key " + name);
            KeyGenerator generator = KeyGenerator.getInstance("AES");
            generator.init(256);
            key = generator.generateKey();
            keys.put(name, key);
            return key;
        }

        @Override public byte[] seal(String keyName, String aad, byte[] plain, int off, int len) throws Exception {
            if (transientFailure != null) throw transientFailure;
            sealCount++;
            return NativeCrypto.encrypt(key(keyName, true), aad, plain, off, len);
        }

        @Override public byte[] open(String keyName, String aad, byte[] sealed) throws Exception {
            if (transientFailure != null) throw transientFailure;
            openCount++;
            return NativeCrypto.decrypt(key(keyName, false), aad, sealed);
        }

        @Override public boolean deleteKey(String keyName) { return keys.remove(keyName) != null; }

        @Override public boolean hasKey(String keyName) { return keys.containsKey(keyName); }

        /** A Keystore reset: every key is gone, every file stays. */
        void loseAllKeys() { keys.clear(); }
    }

    /** java.nio implementation of the durable file operations. */
    static class JvmFiles implements FileOps {
        @Override public void mkdirs(File dir) throws IOException {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdirs failed");
        }

        @Override public void writeDurable(File target, byte[]... parts) throws IOException {
            File temp = new File(target.getParentFile(), target.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                for (byte[] part : parts) out.write(part);
                out.getFD().sync();
            }
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        }

        @Override public void renameDurable(File from, File to) throws IOException {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        }

        @Override public boolean delete(File file) { return file.delete() || !file.exists(); }

        @Override public void syncDir(File dir) { }
    }

    /**
     * Throws an IOException from mutations while {@link #broken} is set (a full or failing disk), or from exactly the
     * write whose 1-based number equals {@link #failWriteNumber}.
     */
    static final class FlakyFiles extends JvmFiles {
        boolean broken;
        int failWriteNumber;
        int writes;

        @Override public void writeDurable(File target, byte[]... parts) throws IOException {
            writes++;
            if (broken || writes == failWriteNumber) throw new IOException("disk failure");
            super.writeDurable(target, parts);
        }

        @Override public void renameDurable(File from, File to) throws IOException {
            if (broken) throw new IOException("disk failure");
            super.renameDurable(from, to);
        }
    }

    /**
     * Power-loss simulator. The k-th mutating operation (1-based) "crashes": nothing of it happens (BEFORE) or a torn
     * temporary file is left behind (TORN, writes only). From then on every mutation is silently ignored, so code that
     * unwinds (finally blocks) cannot change what a real power cut would have left on disk.
     */
    static final class CrashingFiles extends JvmFiles {
        static final class SimulatedCrash extends Error {
            private static final long serialVersionUID = 1L;
        }

        private final int crashAt;
        private final boolean torn;
        int operations;
        private boolean frozen;

        CrashingFiles(int crashAt, boolean torn) {
            this.crashAt = crashAt;
            this.torn = torn;
        }

        private boolean mutate(File target, byte[][] partsOrNull) {
            if (frozen) return false;
            operations++;
            if (crashAt > 0 && operations == crashAt) {
                frozen = true;
                if (torn && partsOrNull != null) {
                    try (FileOutputStream out = new FileOutputStream(new File(target.getParentFile(), target.getName() + ".tmp"))) {
                        int total = 0;
                        for (byte[] part : partsOrNull) total += part.length;
                        int keep = total / 2;
                        for (byte[] part : partsOrNull) {
                            int n = Math.min(part.length, keep);
                            out.write(part, 0, n);
                            keep -= n;
                        }
                    } catch (IOException ignored) { /* best effort tear */ }
                }
                throw new SimulatedCrash();
            }
            return true;
        }

        @Override public void mkdirs(File dir) throws IOException { if (mutate(dir, null)) super.mkdirs(dir); }

        @Override public void writeDurable(File target, byte[]... parts) throws IOException { if (mutate(target, parts)) super.writeDurable(target, parts); }

        @Override public void renameDurable(File from, File to) throws IOException { if (mutate(to, null)) super.renameDurable(from, to); }

        @Override public boolean delete(File file) { return !mutate(file, null) || super.delete(file); }
    }

    /** The legacy (0.2.1.x) outbox: one encrypted JSON array with every photo inside. */
    static JSONObject legacyRow(String id, String status, byte[] jpeg, long createdMs) throws Exception {
        return new JSONObject().put("accountId", ACCOUNT).put("clientRequestId", id)
                .put("fields", new JSONObject().put("lat", "-6.2").put("lng", "106.8").put("locationName", "Kebun Cengkeh — Maluku")
                        .put("cropId", JSONObject.NULL).put("tier", "fast"))
                .put("imageBase64", B64.encode(jpeg)).put("createdMs", createdMs).put("status", status);
    }

    static File legacyBlobFile(File root, String account) {
        return new File(root, StoreNames.fileKey(account) + ".outbox");
    }

    static void writeLegacyBlob(File root, SoftwareVault vault, String account, List<JSONObject> rows) throws Exception {
        JSONArray array = new JSONArray();
        for (JSONObject row : rows) array.put(row);
        byte[] envelope = vault.seal(account + ":outbox", account + ":outbox", array.toString().getBytes(StandardCharsets.UTF_8));
        Files.write(legacyBlobFile(root, account).toPath(), envelope);
    }

    /** Three realistic legacy drafts: pending, submitted (with receipt) and blocked (with error and wait). */
    static List<JSONObject> sampleLegacyRows(List<byte[]> imagesOut) throws Exception {
        List<JSONObject> rows = new ArrayList<>();
        byte[][] images = {randomBytes(5000, 1), randomBytes(1200, 2), randomBytes(200_000, 3)};
        String[] ids = {"draft-aaa", "draft-bbb", "draft-ccc"};
        String[] statuses = {"pending", "submitted", "blocked"};
        for (int i = 0; i < 3; i++) {
            JSONObject row = legacyRow(ids[i], statuses[i], images[i], 1_799_000_000_000L + i);
            if (i == 1) row.put("jobId", "job_123");
            if (i == 2) row.put("error", "authentication_required").put("nextAttemptAtMs", 1_800_000_100_000L);
            rows.add(row);
            if (imagesOut != null) imagesOut.add(images[i]);
        }
        return rows;
    }

    static byte[] sha(byte[] data) { return StoreNames.sha256Hex(data).getBytes(StandardCharsets.US_ASCII); }

    static SecureRandom random() { return new SecureRandom(); }
}
