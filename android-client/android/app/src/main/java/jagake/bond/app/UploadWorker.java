package jagake.bond.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.ExistingWorkPolicy;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

/**
 * WorkManager adapter for {@link UploadEngine}: one run uploads one draft. Retries are scheduled by the engine from the
 * draft's own back-off (see {@link UploadPolicy}); WorkManager's retry is only used when the store itself fails.
 */
public final class UploadWorker extends Worker {
    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @NonNull @Override public Result doWork() {
        String accountId = getInputData().getString("accountId");
        String requestId = getInputData().getString("clientRequestId");
        if (!JagaSyncPlugin.validAccount(accountId) || requestId == null) return Result.failure();
        Context context = getApplicationContext();
        UploadEngine engine = new UploadEngine(NativeStore.outbox(context), new AndroidEnv(context), new HttpTransport(), NativeStore.LOCK);
        switch (engine.run(accountId, requestId, getRunAttemptCount())) {
            case RETRY: return Result.retry();
            case FAIL: return Result.failure();
            default: return Result.success();
        }
    }

    private static final class AndroidEnv implements UploadEngine.Env {
        private final Context context;

        AndroidEnv(Context context) { this.context = context; }

        @Override public long now() { return System.currentTimeMillis(); }

        @Override public String activeAccount() { return NativeStore.activeAccount(context); }

        @Override public long generation() { return NativeStore.generation(context); }

        @Override public JSONObject session(String account) throws Exception { return NativeStore.session(context, account); }

        @Override public void schedule(String account, String id, long delayMs) {
            UploadScheduler.enqueue(context, account, id, delayMs, ExistingWorkPolicy.APPEND_OR_REPLACE);
        }
    }
}
