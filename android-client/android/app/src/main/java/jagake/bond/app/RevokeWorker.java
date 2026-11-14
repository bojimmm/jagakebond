package jagake.bond.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Delivers a logout that could not reach the server (offline logout). The local session was locked at once; this job
 * revokes the old server session when the phone is online again, then deletes the stored token and its key.
 */
public final class RevokeWorker extends Worker {
    static final String TAG = "jaga-revoke";
    /** WorkManager caps its own back-off at 5 hours, so this is more than a week of trying. */
    private static final int MAX_RUN_ATTEMPTS = 40;

    public RevokeWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    static String workName(String accountId, String revokeId) {
        return "jaga-revoke-" + NativeStore.safeWorkId(accountId) + "-" + revokeId;
    }

    static void enqueue(Context context, String accountId, String revokeId, ExistingWorkPolicy policy) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        Data input = new Data.Builder().putString("accountId", accountId).putString("revokeId", revokeId).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(RevokeWorker.class).setInputData(input).setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag(TAG).build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(workName(accountId, revokeId), policy, request);
    }

    @NonNull @Override public Result doWork() {
        String accountId = getInputData().getString("accountId");
        String revokeId = getInputData().getString("revokeId");
        if (!JagaSyncPlugin.validAccount(accountId) || revokeId == null) return Result.failure();
        RevokeQueue queue = NativeStore.revokes(getApplicationContext());
        try {
            RevokeQueue.Entry entry = queue.read(accountId, revokeId);
            if (entry == null) return Result.success();
            if (queue.expired(entry) || getRunAttemptCount() >= MAX_RUN_ATTEMPTS) {
                queue.delete(accountId, revokeId);
                return Result.success();
            }
            int status = logout(entry);
            if (RevokeQueue.shouldRetry(status)) return Result.retry();
            queue.delete(accountId, revokeId);
            return Result.success();
        } catch (IOException noNetwork) {
            return Result.retry();
        } catch (Exception unexpected) {
            return getRunAttemptCount() + 1 >= MAX_RUN_ATTEMPTS ? Result.failure() : Result.retry();
        }
    }

    private static int logout(RevokeQueue.Entry entry) throws IOException {
        HttpURLConnection connection = NativeHttp.open("/api/auth/logout", "POST", NativeHttp.JSON_TIMEOUT_MS, NativeHttp.JSON_TIMEOUT_MS);
        connection.setRequestProperty("Cookie", entry.cookie);
        if (!entry.csrf.isEmpty()) connection.setRequestProperty("X-CSRF-Token", entry.csrf);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(body.length);
        try (NativeHttp.Deadline ignored = new NativeHttp.Deadline(connection, NativeHttp.JSON_DEADLINE_MS)) {
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            try { NativeHttp.readBounded(stream, NativeHttp.MAX_JSON_BYTES); }
            finally { if (stream != null) stream.close(); }
            return status;
        } finally {
            connection.disconnect();
        }
    }
}
