package jagake.bond.app;

import android.content.Context;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** WorkManager side of the uploads: unique work per draft, plus the recovery pass that decides what to queue. */
final class UploadScheduler {
    static final String TAG = "jaga-upload";
    private static final String DRAFT_TAG = "jaga-draft:";

    private UploadScheduler() { }

    static String workName(String accountId, String requestId) {
        return "jaga-upload-" + NativeStore.safeWorkId(accountId) + "-" + requestId;
    }

    static String draftTag(String accountId, String requestId) {
        return DRAFT_TAG + NativeStore.safeWorkId(accountId) + ":" + requestId;
    }

    static void enqueue(Context context, String accountId, String requestId, long delayMs, ExistingWorkPolicy policy) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        Data input = new Data.Builder().putString("accountId", accountId).putString("clientRequestId", requestId).build();
        OneTimeWorkRequest.Builder builder = new OneTimeWorkRequest.Builder(UploadWorker.class)
                .setInputData(input).setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(TAG).addTag(draftTag(accountId, requestId));
        if (delayMs > 0) builder.setInitialDelay(delayMs, TimeUnit.MILLISECONDS);
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(workName(accountId, requestId), policy, builder.build());
    }

    static void cancel(Context context, String accountId, String requestId) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(workName(accountId, requestId));
    }

    /**
     * Audit H-1: rows stuck in {@code uploading} without work go back to {@code pending}; everything that may be tried
     * now is queued. Safe to call repeatedly (activate, app start, sign-in, "Sinkronkan").
     */
    static void recoverAndSchedule(Context context, String accountId) throws Exception {
        List<RecoveryPlanner.Plan> plans = RecoveryPlanner.run(NativeStore.outbox(context), accountId,
                new ManagerProbe(context), System.currentTimeMillis());
        for (RecoveryPlanner.Plan plan : plans) {
            enqueue(context, accountId, plan.id, plan.delayMs, plan.replace ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP);
        }
    }

    /** After a sign-in: release drafts that waited for it, queue uploads and any logout that still has to be delivered. */
    static void afterLogin(Context context, String accountId) {
        try { RecoveryPlanner.releaseAfterLogin(NativeStore.outbox(context), accountId); } catch (Exception ignored) { /* list() reports store errors */ }
        try { recoverAndSchedule(context, accountId); } catch (Exception ignored) { /* retried on the next activate */ }
        scheduleRevokes(context, accountId);
    }

    static void scheduleRevokes(Context context, String accountId) {
        try {
            for (String id : NativeStore.revokes(context).ids(accountId)) RevokeWorker.enqueue(context, accountId, id, ExistingWorkPolicy.KEEP);
        } catch (Exception ignored) { /* WorkManager keeps the jobs it already has */ }
    }

    private static final class ManagerProbe implements RecoveryPlanner.WorkProbe {
        private final Context context;

        ManagerProbe(Context context) { this.context = context.getApplicationContext(); }

        @Override public Map<String, RecoveryPlanner.State> snapshot(String account) throws Exception {
            List<WorkInfo> infos = WorkManager.getInstance(context).getWorkInfosByTag(TAG).get(5, TimeUnit.SECONDS);
            String prefix = DRAFT_TAG + NativeStore.safeWorkId(account) + ":";
            Map<String, RecoveryPlanner.State> states = new HashMap<>();
            for (WorkInfo info : infos) {
                RecoveryPlanner.State state = stateOf(info.getState());
                for (String tag : info.getTags()) {
                    if (!tag.startsWith(prefix)) continue;
                    String id = tag.substring(prefix.length());
                    RecoveryPlanner.State known = states.get(id);
                    if (known == null || state.ordinal() > known.ordinal()) states.put(id, state);
                }
            }
            return states;
        }

        private static RecoveryPlanner.State stateOf(WorkInfo.State state) {
            if (state == WorkInfo.State.RUNNING) return RecoveryPlanner.State.RUNNING;
            if (state == WorkInfo.State.ENQUEUED || state == WorkInfo.State.BLOCKED) return RecoveryPlanner.State.WAITING;
            return RecoveryPlanner.State.NONE;
        }
    }
}
