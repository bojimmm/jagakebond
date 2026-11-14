package jagake.bond.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * Android glue for the encrypted stores: the Keystore-backed {@link Vault}, the account state (active account and
 * generation) and the account session. The draft outbox, the photo archive and the pending-revoke queue are pure
 * classes ({@link OutboxStore}, {@link PhotoArchive}, {@link RevokeQueue}) wired to this vault here.
 */
final class NativeStore {
    private static final String KEYSTORE = "AndroidKeyStore";

    static final Object LOCK = new Object();

    private static final Vault VAULT = new KeystoreVault();
    private static final FileOps FILES = new OsFiles();
    private static final OutboxStore.Clock CLOCK = new OutboxStore.Clock() {
        @Override public long now() { return System.currentTimeMillis(); }
    };
    private static OutboxStore outbox;
    private static PhotoArchive photos;
    private static RevokeQueue revokes;

    private NativeStore() {}

    static OutboxStore outbox(Context context) {
        synchronized (LOCK) {
            if (outbox == null) outbox = new OutboxStore(context.getApplicationContext().getNoBackupFilesDir(), VAULT, FILES, CLOCK, LOCK);
            return outbox;
        }
    }

    static PhotoArchive photos(Context context) {
        synchronized (LOCK) {
            if (photos == null) photos = new PhotoArchive(context.getApplicationContext().getNoBackupFilesDir(), VAULT, FILES, LOCK);
            return photos;
        }
    }

    static RevokeQueue revokes(Context context) {
        synchronized (LOCK) {
            if (revokes == null) revokes = new RevokeQueue(context.getApplicationContext().getNoBackupFilesDir(), VAULT, FILES, CLOCK, LOCK);
            return revokes;
        }
    }

    static String activeAccount(Context context) {
        return context.getSharedPreferences("native_state", Context.MODE_PRIVATE).getString("active", null);
    }

    static void setActive(Context context, String accountId) {
        synchronized (LOCK) {
            context.getSharedPreferences("native_state", Context.MODE_PRIVATE).edit()
                    .putString("active", accountId).putLong("generation", generation(context) + 1).commit();
        }
    }

    static long generation(Context context) {
        return context.getSharedPreferences("native_state", Context.MODE_PRIVATE).getLong("generation", 0);
    }

    static void lock(Context context) {
        synchronized (LOCK) {
            String account = activeAccount(context);
            if (account != null) {
                try { delete(context, sessionFile(context, account)); }
                catch (Exception ignored) { /* Clear active state even if key or file is unavailable. */ }
            }
            context.getSharedPreferences("native_state", Context.MODE_PRIVATE).edit()
                    .remove("active").putLong("generation", generation(context) + 1).commit();
            androidx.work.WorkManager.getInstance(context).cancelAllWorkByTag(UploadScheduler.TAG);
        }
    }

    static void saveSession(Context context, String accountId, JSONObject value) throws Exception {
        synchronized (LOCK) { write(context, sessionFile(context, accountId), accountId + ":session", value.toString()); }
    }

    static JSONObject session(Context context, String accountId) throws Exception {
        synchronized (LOCK) {
            File file = sessionFile(context, accountId);
            if (!file.exists()) return null;
            return new JSONObject(read(context, file, accountId + ":session"));
        }
    }

    static String fileKey(String accountId) throws Exception {
        return StoreNames.fileKey(accountId);
    }

    static String safeWorkId(String accountId) {
        return StoreNames.fileKey(accountId);
    }

    private static File sessionFile(Context context, String accountId) throws Exception {
        return new File(context.getNoBackupFilesDir(), fileKey(accountId) + ".session");
    }
    private static File delete(Context context, File file) { file.delete(); return file; }

    /** @throws Vault.KeyMissingException when the alias is not in the Keystore and {@code create} is false. */
    private static SecretKey key(String alias, boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(alias)) return ((KeyStore.SecretKeyEntry) store.getEntry(alias, null)).getSecretKey();
        if (!create) throw new Vault.KeyMissingException("Encryption key is unavailable; stored data was preserved");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private static void write(Context context, File file, String namespace, String text) throws Exception {
        byte[] envelope = NativeCrypto.encrypt(key(fileKey(namespace), true), namespace, text.getBytes(StandardCharsets.UTF_8));
        FILES.writeDurable(file, envelope);
    }

    private static String read(Context context, File file, String namespace) throws Exception {
        byte[] data = OutboxStore.readAll(file);
        byte[] plaintext = NativeCrypto.decrypt(key(fileKey(namespace), false), namespace, data);
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    /** Android Keystore AES-256-GCM keys, one per logical key name (session, outbox, each archived photo). */
    static final class KeystoreVault implements Vault {
        @Override public byte[] seal(String keyName, String aad, byte[] plain, int off, int len) throws Exception {
            return NativeCrypto.encrypt(key(StoreNames.fileKey(keyName), true), aad, plain, off, len);
        }

        @Override public byte[] open(String keyName, String aad, byte[] sealed) throws Exception {
            return NativeCrypto.decrypt(key(StoreNames.fileKey(keyName), false), aad, sealed);
        }

        @Override public boolean deleteKey(String keyName) throws Exception {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            String alias = StoreNames.fileKey(keyName);
            if (!store.containsAlias(alias)) return false;
            store.deleteEntry(alias);
            return true;
        }

        @Override public boolean hasKey(String keyName) throws Exception {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            return store.containsAlias(StoreNames.fileKey(keyName));
        }
    }
}
