package jagake.bond.app;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Server sessions whose logout request could not be delivered (offline logout, audit "Low").
 * The local session is locked at once as before; the old session token is kept encrypted here and revoked by a
 * background job when the phone is online again, then deleted together with its Keystore key.
 */
final class RevokeQueue {
    /** A session cookie is valid for 30 days, so nothing older than this can still need revoking. */
    static final long MAX_AGE_MS = 31L * 24 * 60 * 60 * 1000;

    static final class Entry {
        final String cookie;
        final String csrf;
        final long createdMs;
        final long expiresAtMs;

        Entry(String cookie, String csrf, long createdMs, long expiresAtMs) {
            this.cookie = cookie;
            this.csrf = csrf;
            this.createdMs = createdMs;
            this.expiresAtMs = expiresAtMs;
        }
    }

    /**
     * Whether an answer to the logout request means "try again later". 2xx is done; 401/403 means the server already
     * considers the session invalid; any other 4xx cannot be fixed by waiting.
     */
    static boolean shouldRetry(int status) {
        return status == 408 || status == 425 || status == 429 || status >= 500 || (status >= 300 && status < 400);
    }

    private final File root;
    private final Vault vault;
    private final FileOps files;
    private final OutboxStore.Clock clock;
    private final Object lock;

    RevokeQueue(File root, Vault vault, FileOps files, OutboxStore.Clock clock, Object lock) {
        this.root = root;
        this.vault = vault;
        this.files = files;
        this.clock = clock;
        this.lock = lock;
    }

    private String prefix(String account) { return StoreNames.fileKey(account) + ".revoke."; }

    private static String name(String account, String id) { return account + ":revoke:" + id; }

    private File file(String account, String id) { return new File(root, prefix(account) + id); }

    /** @return the id of the stored entry. */
    String add(String account, String cookie, String csrf, long expiresAtMs) throws Exception {
        String id = UUID.randomUUID().toString().replace("-", "");
        JSONObject json = new JSONObject().put("cookie", cookie).put("csrf", csrf == null ? "" : csrf)
                .put("createdMs", clock.now()).put("expiresAtMs", expiresAtMs);
        byte[] plain = json.toString().getBytes(StandardCharsets.UTF_8);
        synchronized (lock) {
            files.writeDurable(file(account, id), vault.seal(name(account, id), name(account, id), plain));
        }
        return id;
    }

    List<String> ids(String account) {
        List<String> ids = new ArrayList<>();
        String[] names = root.list();
        if (names == null) return ids;
        String prefix = prefix(account);
        for (String n : names) if (n.startsWith(prefix) && !n.endsWith(".tmp")) ids.add(n.substring(prefix.length()));
        return ids;
    }

    /** @return the entry, or null when it does not exist or can no longer be decrypted (then it is dropped). */
    Entry read(String account, String id) throws Exception {
        synchronized (lock) {
            File file = file(account, id);
            if (!file.exists()) return null;
            try {
                byte[] plain = vault.open(name(account, id), name(account, id), OutboxStore.readAll(file));
                JSONObject json = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                return new Entry(json.getString("cookie"), json.optString("csrf", ""), json.optLong("createdMs"), json.optLong("expiresAtMs"));
            } catch (Vault.KeyMissingException | Vault.CorruptDataException e) {
                delete(account, id);
                return null;
            }
        }
    }

    /** True when the session can no longer be valid, so the entry may be dropped without a request. */
    boolean expired(Entry entry) {
        long now = clock.now();
        return (entry.expiresAtMs > 0 && entry.expiresAtMs <= now) || now - entry.createdMs > MAX_AGE_MS;
    }

    void delete(String account, String id) throws Exception {
        synchronized (lock) {
            files.delete(file(account, id));
            vault.deleteKey(name(account, id));
        }
    }
}
