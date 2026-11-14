package jagake.bond.app;

import android.content.Context;

import java.util.concurrent.atomic.AtomicBoolean;

/** App-start recovery (audit H-1): once per process, in the background, for the account that is still signed in. */
final class NativeRecovery {
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);

    private NativeRecovery() { }

    static void start(final Context application) {
        if (!STARTED.compareAndSet(false, true)) return;
        Thread thread = new Thread(new Runnable() {
            @Override public void run() {
                try {
                    String account = NativeStore.activeAccount(application);
                    if (account != null) {
                        UploadScheduler.recoverAndSchedule(application, account);
                        UploadScheduler.scheduleRevokes(application, account);
                    }
                } catch (Throwable ignored) {
                    // Recovery is retried on the next activate(); nothing here may crash the app.
                }
            }
        }, "jaga-recovery");
        thread.setDaemon(true);
        thread.start();
    }
}
