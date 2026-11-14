package jagake.bond.app;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Account-scoped encrypted archive of full-quality photos (the "private originals").
 *
 * <p>One file and one Keystore key per photo, named exactly as in earlier releases so existing photos stay readable:
 * {@code <account>.photo.<photo>} and key {@code <account>:photo:<photo>}. New files use the two-segment {@link Blob}
 * layout (JPEG bytes are never turned into a JSON string); files written by 0.2.1.x are a single JSON envelope and are
 * still read. {@link #delete} removes both the file and the key, which also makes any leftover copy unreadable.
 */
class PhotoArchive {
    static final class Photo {
        final byte[] jpeg;
        final JSONObject metadata;

        Photo(byte[] jpeg, JSONObject metadata) {
            this.jpeg = jpeg;
            this.metadata = metadata;
        }
    }

    private final File root;
    private final Vault vault;
    private final FileOps files;
    private final Object lock;

    PhotoArchive(File root, Vault vault, FileOps files, Object lock) {
        this.root = root;
        this.vault = vault;
        this.files = files;
        this.lock = lock;
    }

    static String namespace(String account, String photoId) { return account + ":photo:" + photoId; }

    File file(String account, String photoId) {
        return new File(root, StoreNames.fileKey(account) + ".photo." + StoreNames.fileKey(photoId));
    }

    boolean exists(String account, String photoId) {
        synchronized (lock) { return file(account, photoId).exists(); }
    }

    void put(String account, String photoId, byte[] jpeg, JSONObject metadata) throws Exception {
        String ns = namespace(account, photoId);
        byte[] meta = metadata.toString().getBytes(StandardCharsets.UTF_8);
        synchronized (lock) {
            Blob.write(files, vault, file(account, photoId), ns, ns + "|m", ns + "|p", meta, jpeg, 0, jpeg.length);
        }
    }

    /** @return null when there is no such photo. */
    Photo get(String account, String photoId) throws Exception {
        String ns = namespace(account, photoId);
        synchronized (lock) {
            File file = file(account, photoId);
            if (!file.exists()) return null;
            if (Blob.isContainer(file)) {
                byte[] meta = Blob.readMeta(vault, file, ns, ns + "|m");
                byte[] jpeg = Blob.readPayload(vault, file, ns, ns + "|p");
                return new Photo(jpeg, new JSONObject(new String(meta, StandardCharsets.UTF_8)));
            }
            byte[] plain = vault.open(ns, ns, OutboxStore.readAll(file));
            JSONObject legacy = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            return new Photo(B64.decode(legacy.getString("image")), legacy.getJSONObject("metadata"));
        }
    }

    /**
     * Deletes the encrypted file and its Keystore key. Idempotent: a missing photo is {@code false}, not an error.
     * The file goes first; if the key removal then fails the call fails and a repeat finishes the job.
     */
    boolean delete(String account, String photoId) throws Exception {
        synchronized (lock) {
            File file = file(account, photoId);
            boolean hadFile = file.exists();
            if (hadFile && !files.delete(file)) throw new IOException("Could not delete the encrypted photo");
            files.delete(new File(file.getParentFile(), file.getName() + ".tmp"));
            boolean hadKey = vault.deleteKey(namespace(account, photoId));
            return hadFile || hadKey;
        }
    }
}
