package jagake.bond.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * Encrypted offline outbox, one directory per account (release 0.2.2.0, audit H-2).
 *
 * <pre>
 *   &lt;account&gt;.outbox.d/index        small encrypted index: status and fields of every draft (what list() reads)
 *   &lt;account&gt;.outbox.d/d.&lt;draft&gt;    one {@link Blob} per draft: metadata + the JPEG (read only when needed)
 *   &lt;account&gt;.outbox               legacy single-blob outbox of releases up to 0.2.1.x (migrated, never written again)
 *   &lt;account&gt;.outbox.migrated      the legacy blob kept until the next successful start
 *   &lt;account&gt;.outbox.q.*           quarantined, undecryptable data (renamed, never deleted)
 * </pre>
 *
 * <p>Safety rules, in order of importance:
 * <ol>
 *   <li>A draft file is always written (and fsynced) before the index names it; the index is always updated before a
 *       draft file is deleted. A crash therefore leaves at most an orphan file, never an index row without data.</li>
 *   <li>Legacy migration writes and verifies every draft file first and commits by writing the index. Only after the
 *       index is durable is the legacy blob renamed away, and that copy is kept until the next successful start.
 *       Any crash before the commit leaves the legacy blob authoritative; the migration simply runs again.</li>
 *   <li>Data is quarantined (renamed) only when the key is definitively gone or authentication failed. A transient
 *       Keystore or I/O error is propagated and leaves every file untouched.</li>
 * </ol>
 * All public methods are synchronized on the shared lock and are safe to call from several threads.
 */
final class OutboxStore {
    interface Clock { long now(); }

    /** Edits one row in place; return true when something changed. */
    interface RowEdit { boolean apply(JSONObject row) throws Exception; }

    /** Edits the whole row list in place (add/remove/reorder); return true when something changed. */
    interface RowsEdit { boolean apply(List<JSONObject> rows) throws Exception; }

    /** The draft's encrypted file is missing or unreadable although the index lists it. */
    static final class PayloadException extends IOException {
        final boolean missing;

        PayloadException(boolean missing, String message) {
            super(message);
            this.missing = missing;
        }
    }

    static final class Draft {
        final JSONObject meta;
        /** Decrypted JPEG; null when only the unreadable legacy text could be preserved. */
        final byte[] image;
        /** Preserved legacy base64 text for an image that could not be decoded during migration. */
        final String rawBase64;

        Draft(JSONObject meta, byte[] image, String rawBase64) {
            this.meta = meta;
            this.image = image;
            this.rawBase64 = rawBase64;
        }
    }

    static final class Listing {
        final List<JSONObject> rows;
        /** Quarantined drafts the web has not acknowledged yet. */
        final int quarantined;
        /** True when at least one quarantined item had an unknowable size (an unreadable legacy blob). */
        final boolean quarantinedApprox;

        Listing(List<JSONObject> rows, int quarantined, boolean quarantinedApprox) {
            this.rows = rows;
            this.quarantined = quarantined;
            this.quarantinedApprox = quarantinedApprox;
        }
    }

    private static final int FORMAT = 2;
    private static final String INDEX = "index";
    private static final String DRAFT_PREFIX = "d.";
    private static final String BAD_PREFIX = "bad.";
    private static final String TMP = ".tmp";

    private final File root;
    private final Vault vault;
    private final FileOps files;
    private final Clock clock;
    private final Object lock;
    private final Set<String> ready = new HashSet<>();

    OutboxStore(File root, Vault vault, FileOps files, Clock clock, Object lock) {
        this.root = root;
        this.vault = vault;
        this.files = files;
        this.clock = clock;
        this.lock = lock;
    }

    // ------------------------------------------------------------------ public API

    /** Reads only the index. */
    Listing list(String account) throws Exception {
        synchronized (lock) {
            List<JSONObject> rows = rows(account);
            long[] totals = quarantineTotals(account);
            long unacknowledged = Math.max(0, totals[0] - readAck(account));
            return new Listing(rows, (int) unacknowledged, unacknowledged > 0 && totals[1] != 0);
        }
    }

    /** The index row of one draft, or null. */
    JSONObject meta(String account, String id) throws Exception {
        synchronized (lock) {
            for (JSONObject row : rows(account)) if (id.equals(row.optString("clientRequestId"))) return row;
            return null;
        }
    }

    /** Stores a new draft: encrypted file first, index second. */
    void add(String account, String id, JSONObject fields, long createdMs, String status, byte[] jpeg) throws Exception {
        synchronized (lock) {
            List<JSONObject> rows = rows(account);
            for (JSONObject row : rows) {
                if (id.equals(row.optString("clientRequestId"))) throw new IllegalStateException("Draft already exists");
            }
            JSONObject cleanFields = new JSONObject(fields.toString());
            String sha = StoreNames.sha256Hex(jpeg);
            JSONObject draftMeta = new JSONObject().put("clientRequestId", id).put("createdMs", createdMs)
                    .put("fields", cleanFields).put("imgFmt", "jpeg").put("imgSha", sha).put("imgBytes", jpeg.length);
            files.mkdirs(dir(account));
            writeDraftFile(account, id, draftMeta, jpeg, 0, jpeg.length);
            JSONObject row = new JSONObject().put("clientRequestId", id).put("createdMs", createdMs)
                    .put("fields", new JSONObject(fields.toString())).put("status", status)
                    .put("imgSha", sha).put("imgBytes", jpeg.length);
            rows.add(row);
            writeRows(account, rows);
        }
    }

    /** Edits one row; one index write. @return false when the draft does not exist. */
    boolean update(String account, String id, RowEdit edit) throws Exception {
        synchronized (lock) {
            List<JSONObject> rows = rows(account);
            for (JSONObject row : rows) {
                if (!id.equals(row.optString("clientRequestId"))) continue;
                if (edit.apply(row)) writeRows(account, rows);
                return true;
            }
            return false;
        }
    }

    /** Edits all rows with a single index write. */
    boolean edit(String account, RowsEdit edit) throws Exception {
        synchronized (lock) {
            List<JSONObject> rows = rows(account);
            boolean changed = edit.apply(rows);
            if (changed) writeRows(account, rows);
            return changed;
        }
    }

    /** Index first, file second. @return true when the draft existed. */
    boolean remove(String account, String id) throws Exception {
        synchronized (lock) {
            List<JSONObject> rows = rows(account);
            boolean found = false;
            for (Iterator<JSONObject> it = rows.iterator(); it.hasNext(); ) {
                if (id.equals(it.next().optString("clientRequestId"))) {
                    it.remove();
                    found = true;
                }
            }
            if (found) writeRows(account, rows);
            files.delete(draftFile(account, id));
            return found;
        }
    }

    /** Reads the draft with its photo. @return null when there is no such draft. */
    Draft readDraft(String account, String id) throws Exception {
        synchronized (lock) {
            JSONObject row = meta(account, id);
            if (row == null) return null;
            File file = draftFile(account, id);
            if (!file.exists()) throw new PayloadException(true, "Draft photo file is missing");
            byte[] metaBytes;
            byte[] payload;
            try {
                metaBytes = Blob.readMeta(vault, file, keyName(account), aadMeta(account));
                payload = Blob.readPayload(vault, file, keyName(account), aadPayload(account, id));
            } catch (Vault.CorruptDataException e) {
                quarantineFile(file);
                throw new PayloadException(false, "Draft photo file is unreadable");
            }
            JSONObject fileMeta = new JSONObject(new String(metaBytes, StandardCharsets.UTF_8));
            if ("b64raw".equals(fileMeta.optString("imgFmt"))) {
                return new Draft(row, null, new String(payload, StandardCharsets.UTF_8));
            }
            return new Draft(row, payload, null);
        }
    }

    /**
     * Atomically replaces a draft by an edited copy under a new id (the web's "edit location" flow).
     * The photo is re-sealed under the new id; the old file is removed only after the index names the new one.
     */
    void replace(String account, String oldId, String newId, JSONObject newFields, String newStatus) throws Exception {
        synchronized (lock) {
            Draft old = readDraft(account, oldId);
            if (old == null || old.image == null) throw new IllegalStateException("Draft cannot be edited");
            List<JSONObject> rows = rows(account);
            for (JSONObject row : rows) {
                if (newId.equals(row.optString("clientRequestId"))) throw new IllegalStateException("New draft id already exists");
            }
            long createdMs = old.meta.optLong("createdMs");
            String sha = StoreNames.sha256Hex(old.image);
            JSONObject draftMeta = new JSONObject().put("clientRequestId", newId).put("createdMs", createdMs)
                    .put("fields", new JSONObject(newFields.toString())).put("imgFmt", "jpeg").put("imgSha", sha)
                    .put("imgBytes", old.image.length);
            writeDraftFile(account, newId, draftMeta, old.image, 0, old.image.length);
            JSONObject replacement = new JSONObject().put("clientRequestId", newId).put("createdMs", createdMs)
                    .put("fields", new JSONObject(newFields.toString())).put("status", newStatus)
                    .put("imgSha", sha).put("imgBytes", old.image.length);
            for (Iterator<JSONObject> it = rows.iterator(); it.hasNext(); ) {
                if (oldId.equals(it.next().optString("clientRequestId"))) it.remove();
            }
            rows.add(replacement);
            writeRows(account, rows);
            files.delete(draftFile(account, oldId));
        }
    }

    /** The web has shown the "drafts could not be opened" notice: stop reporting what is quarantined today. */
    void acknowledgeQuarantine(String account) throws Exception {
        synchronized (lock) {
            ensureReady(account);
            long total = quarantineTotals(account)[0];
            files.writeDurable(ackFile(account), Long.toString(total).getBytes(StandardCharsets.US_ASCII));
        }
    }

    // ------------------------------------------------------------------ names

    private static String keyName(String account) { return account + ":outbox"; }

    private static String aadIndex(String account) { return account + ":outbox:index"; }

    private static String aadMeta(String account) { return account + ":outbox:dmeta"; }

    private static String aadPayload(String account, String id) { return account + ":outbox:draft:" + id; }

    File dir(String account) { return new File(root, StoreNames.fileKey(account) + ".outbox.d"); }

    File legacyFile(String account) { return new File(root, StoreNames.fileKey(account) + ".outbox"); }

    File backupFile(String account) { return new File(root, StoreNames.fileKey(account) + ".outbox.migrated"); }

    private File ackFile(String account) { return new File(root, StoreNames.fileKey(account) + ".outbox.qack"); }

    File draftFile(String account, String id) { return new File(dir(account), DRAFT_PREFIX + StoreNames.fileKey(id)); }

    // ------------------------------------------------------------------ index

    /** Rows of the index; when the key vanished or the index broke at run time, heal once and retry. */
    private List<JSONObject> rows(String account) throws Exception {
        ensureReady(account);
        try {
            return readRowsOrEmpty(account);
        } catch (Vault.KeyMissingException | Vault.CorruptDataException e) {
            ready.remove(account);
            ensureReady(account);
            return readRowsOrEmpty(account);
        }
    }

    private List<JSONObject> readRowsOrEmpty(String account) throws Exception {
        if (!new File(dir(account), INDEX).exists()) return new ArrayList<>();
        return readRows(account);
    }

    private List<JSONObject> readRows(String account) throws Exception {
        byte[] plain = vault.open(keyName(account), aadIndex(account), readAll(new File(dir(account), INDEX)));
        try {
            JSONObject index = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            if (index.optInt("v", 0) != FORMAT) throw new Vault.CorruptDataException("Unsupported outbox index version");
            JSONArray array = index.getJSONArray("rows");
            List<JSONObject> rows = new ArrayList<>(array.length());
            for (int i = 0; i < array.length(); i++) rows.add(array.getJSONObject(i));
            return rows;
        } catch (JSONException e) {
            throw new Vault.CorruptDataException("Outbox index is malformed", e);
        }
    }

    private void writeRows(String account, List<JSONObject> rows) throws Exception {
        JSONArray array = new JSONArray();
        for (JSONObject row : rows) array.put(row);
        byte[] plain = new JSONObject().put("v", FORMAT).put("rows", array).toString().getBytes(StandardCharsets.UTF_8);
        files.writeDurable(new File(dir(account), INDEX), vault.seal(keyName(account), aadIndex(account), plain));
    }

    private void writeDraftFile(String account, String id, JSONObject draftMeta, byte[] image, int off, int len) throws Exception {
        Blob.write(files, vault, draftFile(account, id), keyName(account), aadMeta(account), aadPayload(account, id),
                draftMeta.toString().getBytes(StandardCharsets.UTF_8), image, off, len);
    }

    // ------------------------------------------------------------------ start-up: open, migrate, heal

    /** Runs once per account and process: opens the index, migrates the legacy blob, quarantines what cannot be read. */
    private void ensureReady(String account) throws Exception {
        synchronized (lock) {
            if (ready.contains(account)) return;
            deleteStaleTemps(account);
            List<JSONObject> rows = null;
            File indexFile = new File(dir(account), INDEX);
            if (indexFile.exists()) {
                try {
                    rows = readRows(account);
                } catch (Vault.KeyMissingException e) {
                    quarantineDirectory(account);
                } catch (Vault.CorruptDataException e) {
                    try {
                        rows = rebuildIndex(account);
                    } catch (Vault.KeyMissingException gone) {
                        quarantineDirectory(account);
                        rows = null;
                    }
                }
            }
            boolean migratedNow = legacyFile(account).exists();
            if (migratedNow) rows = migrateLegacy(account, rows == null ? new ArrayList<JSONObject>() : rows);
            if (rows == null) rows = new ArrayList<>();
            try {
                if (!migratedNow) retireBackup(account, rows);
                sweepOrphans(account, rows);
            } catch (Exception cleanupFailure) {
                // Housekeeping is best effort: a failed sweep must never make the outbox unusable.
            }
            ready.add(account);
        }
    }

    private void deleteStaleTemps(String account) {
        String[] names = dir(account).list();
        if (names != null) {
            for (String name : names) if (name.endsWith(TMP)) files.delete(new File(dir(account), name));
        }
        files.delete(new File(root, StoreNames.fileKey(account) + ".outbox" + TMP));
        files.delete(new File(root, StoreNames.fileKey(account) + ".outbox.qack" + TMP));
    }

    /** The index is unreadable but the key is fine: rebuild it from the self-describing draft files. */
    private List<JSONObject> rebuildIndex(String account) throws Exception {
        List<JSONObject> rows = new ArrayList<>();
        File[] found = dir(account).listFiles();
        if (found != null) {
            Arrays.sort(found, new Comparator<File>() {
                @Override public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
            });
            for (File file : found) {
                String name = file.getName();
                if (!name.startsWith(DRAFT_PREFIX) || name.endsWith(TMP)) continue;
                try {
                    JSONObject meta = new JSONObject(new String(
                            Blob.readMeta(vault, file, keyName(account), aadMeta(account)), StandardCharsets.UTF_8));
                    String id = meta.getString("clientRequestId");
                    if (!name.equals(DRAFT_PREFIX + StoreNames.fileKey(id))) throw new Vault.CorruptDataException("Draft file name mismatch");
                    JSONObject row = new JSONObject().put("clientRequestId", id).put("createdMs", meta.optLong("createdMs"))
                            .put("fields", meta.optJSONObject("fields") == null ? new JSONObject() : meta.getJSONObject("fields"))
                            .put("status", "pending");
                    if (meta.has("imgSha")) row.put("imgSha", meta.getString("imgSha"));
                    if (meta.has("imgBytes")) row.put("imgBytes", meta.getInt("imgBytes"));
                    rows.add(row);
                } catch (Vault.CorruptDataException | JSONException e) {
                    quarantineFile(file);
                }
            }
        }
        Collections.sort(rows, new Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) { return Long.compare(a.optLong("createdMs"), b.optLong("createdMs")); }
        });
        writeRows(account, rows);
        return rows;
    }

    /**
     * Single-blob outbox to per-draft files. Lossless and crash-safe (see the class comment). Rows already known to the
     * index win; rows only the blob knows (a downgrade/upgrade round trip, or a repeated run) are added.
     */
    private List<JSONObject> migrateLegacy(String account, List<JSONObject> existing) throws Exception {
        File legacy = legacyFile(account);
        byte[] plain;
        try {
            plain = vault.open(keyName(account), keyName(account), readAll(legacy));
        } catch (Vault.KeyMissingException | Vault.CorruptDataException e) {
            quarantineLegacy(account);
            return existing;
        }
        files.mkdirs(dir(account));
        Set<String> known = new HashSet<>();
        for (JSONObject row : existing) known.add(row.optString("clientRequestId"));
        List<JSONObject> merged = new ArrayList<>(existing);
        List<String[]> toVerify = new ArrayList<>();
        boolean damaged = false;
        boolean added = false;
        try {
            JsonArraySplitter elements = new JsonArraySplitter(plain);
            while (elements.hasNext()) {
                JSONObject legacyRow;
                try {
                    legacyRow = new JSONObject(elements.next());
                } catch (JSONException e) {
                    damaged = true;
                    continue;
                }
                String id = legacyRow.optString("clientRequestId", "");
                if (id.isEmpty()) {
                    damaged = true;
                    continue;
                }
                String text = legacyRow.has("imageBase64") && !legacyRow.isNull("imageBase64") ? legacyRow.optString("imageBase64", "") : "";
                byte[] jpeg = null;
                try {
                    jpeg = B64.decode(text);
                    if (jpeg.length == 0) jpeg = null;
                } catch (IllegalArgumentException e) {
                    jpeg = null;
                }
                boolean isKnown = known.contains(id);
                if (isKnown) {
                    if (jpeg != null && tryReadPayload(account, id) == null) {
                        // The index names it but its file is missing or broken (an interrupted earlier run): repair from the blob.
                        JSONObject repairMeta = draftMeta(legacyRow, id, "jpeg", StoreNames.sha256Hex(jpeg), jpeg.length);
                        writeDraftFile(account, id, repairMeta, jpeg, 0, jpeg.length);
                        toVerify.add(new String[]{id, StoreNames.sha256Hex(jpeg)});
                    }
                    continue;
                }
                JSONObject row = new JSONObject();
                for (Iterator<String> keys = legacyRow.keys(); keys.hasNext(); ) {
                    String key = keys.next();
                    if (!"imageBase64".equals(key) && !"accountId".equals(key)) row.put(key, legacyRow.get(key));
                }
                if (!row.has("fields") || row.isNull("fields")) row.put("fields", new JSONObject());
                if (!row.has("createdMs")) row.put("createdMs", clock.now());
                if (!row.has("status") || row.optString("status").isEmpty()) row.put("status", "pending");
                String sha;
                if (jpeg != null) {
                    sha = StoreNames.sha256Hex(jpeg);
                    writeDraftFile(account, id, draftMeta(legacyRow, id, "jpeg", sha, jpeg.length), jpeg, 0, jpeg.length);
                    row.put("imgSha", sha).put("imgBytes", jpeg.length);
                } else {
                    // Never drop a row: keep the unreadable text, show the draft as failed so the farmer can discard it.
                    byte[] raw = text.getBytes(StandardCharsets.UTF_8);
                    sha = StoreNames.sha256Hex(raw);
                    writeDraftFile(account, id, draftMeta(legacyRow, id, "b64raw", sha, raw.length), raw, 0, raw.length);
                    row.put("status", "failed").put("error", "image_unreadable");
                }
                toVerify.add(new String[]{id, sha});
                merged.add(row);
                known.add(id);
                added = true;
            }
        } catch (IllegalArgumentException malformed) {
            damaged = true;
        }
        plain = null;
        // Verify by reading every written draft back before the index (the commit point) names it.
        for (String[] item : toVerify) {
            byte[] back = tryReadPayload(account, item[0]);
            if (back == null || !item[1].equals(StoreNames.sha256Hex(back))) {
                throw new IOException("Outbox migration verification failed; the legacy outbox was kept untouched");
            }
        }
        if (added || !new File(dir(account), INDEX).exists()) {
            writeRows(account, merged);
            List<JSONObject> reread = readRows(account);
            if (reread.size() != merged.size()) throw new IOException("Outbox migration index verification failed");
        }
        // Commit point passed: only now take the legacy blob out of the way (kept until the next successful start).
        files.renameDurable(legacy, damaged ? uniqueQuarantine(account, ".blob") : backupFile(account));
        return merged;
    }

    private JSONObject draftMeta(JSONObject legacyRow, String id, String format, String sha, int bytes) throws Exception {
        JSONObject fields = legacyRow.optJSONObject("fields");
        return new JSONObject().put("clientRequestId", id).put("createdMs", legacyRow.optLong("createdMs", clock.now()))
                .put("fields", fields == null ? new JSONObject() : new JSONObject(fields.toString()))
                .put("imgFmt", format).put("imgSha", sha).put("imgBytes", bytes);
    }

    /** @return the decrypted photo, or null when the file is missing or fails authentication. Transient errors propagate. */
    private byte[] tryReadPayload(String account, String id) throws Exception {
        File file = draftFile(account, id);
        if (!file.exists()) return null;
        try {
            return Blob.readPayload(vault, file, keyName(account), aadPayload(account, id));
        } catch (Vault.CorruptDataException | FileNotFoundException e) {
            return null;
        }
    }

    /** The pre-migration copy is discarded only when every indexed draft is readable from the new store. */
    private void retireBackup(String account, List<JSONObject> rows) throws Exception {
        File backup = backupFile(account);
        if (!backup.exists()) return;
        for (JSONObject row : rows) {
            File file = draftFile(account, row.optString("clientRequestId"));
            if (!file.exists()) return;
            try {
                Blob.readMeta(vault, file, keyName(account), aadMeta(account));
            } catch (Vault.CorruptDataException e) {
                return;
            }
        }
        files.delete(backup);
    }

    /** Draft files that the index does not name (a crash between file and index) are leftovers and are removed. */
    private void sweepOrphans(String account, List<JSONObject> rows) {
        Set<String> keep = new HashSet<>();
        for (JSONObject row : rows) keep.add(DRAFT_PREFIX + StoreNames.fileKey(row.optString("clientRequestId")));
        String[] names = dir(account).list();
        if (names == null) return;
        for (String name : names) {
            if (name.startsWith(DRAFT_PREFIX) && !name.endsWith(TMP) && !keep.contains(name)) files.delete(new File(dir(account), name));
        }
    }

    // ------------------------------------------------------------------ quarantine

    private File uniqueQuarantine(String account, String suffix) {
        String base = StoreNames.fileKey(account) + ".outbox.q." + clock.now();
        File candidate = new File(root, base + suffix);
        for (int n = 1; candidate.exists(); n++) candidate = new File(root, base + "-" + n + suffix);
        return candidate;
    }

    private void quarantineDirectory(String account) throws IOException {
        files.renameDurable(dir(account), uniqueQuarantine(account, ""));
    }

    private void quarantineLegacy(String account) throws IOException {
        files.renameDurable(legacyFile(account), uniqueQuarantine(account, ".blob"));
    }

    private void quarantineFile(File file) throws IOException {
        File target = new File(file.getParentFile(), BAD_PREFIX + file.getName() + "." + clock.now());
        for (int n = 1; target.exists(); n++) target = new File(file.getParentFile(), BAD_PREFIX + file.getName() + "." + clock.now() + "-" + n);
        files.renameDurable(file, target);
    }

    /** @return {total quarantined units, 1 when one of them has an unknown size}. */
    private long[] quarantineTotals(String account) {
        String prefix = StoreNames.fileKey(account) + ".outbox.q.";
        long total = 0;
        boolean approximate = false;
        String[] names = root.list();
        if (names != null) {
            for (String name : names) {
                if (!name.startsWith(prefix) || name.endsWith(TMP)) continue;
                File item = new File(root, name);
                if (item.isDirectory()) {
                    String[] inner = item.list();
                    if (inner != null) for (String s : inner) if (s.startsWith(DRAFT_PREFIX) && !s.endsWith(TMP)) total++;
                } else {
                    total++;
                    approximate = true;
                }
            }
        }
        String[] live = dir(account).list();
        if (live != null) for (String s : live) if (s.startsWith(BAD_PREFIX)) total++;
        return new long[]{total, approximate ? 1 : 0};
    }

    private long readAck(String account) {
        File file = ackFile(account);
        if (!file.exists()) return 0;
        try {
            return Long.parseLong(new String(readAll(file), StandardCharsets.US_ASCII).trim());
        } catch (Exception e) {
            return 0;
        }
    }

    // ------------------------------------------------------------------ io

    static byte[] readAll(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            long size = file.length();
            if (size > Integer.MAX_VALUE) throw new IOException("File too large");
            byte[] data = new byte[(int) size];
            int offset = 0;
            while (offset < data.length) {
                int count = in.read(data, offset, data.length - offset);
                if (count < 0) throw new IOException("File shrank while reading");
                offset += count;
            }
            return data;
        }
    }
}
