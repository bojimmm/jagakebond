package jagake.bond.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * The only way native code talks to the server: fixed origin, no redirects, bounded responses and timeouts
 * (contract 5.9: JSON 20 s, uploads 90 s, health 10 s; a timeout is a retryable network failure).
 */
final class NativeHttp {
    static final String ORIGIN = "https://jagake.bond";
    /** Sent as X-JK-App-Version on every native request. Must equal versionName in app/build.gradle (a unit test checks). */
    static final String APP_VERSION = "0.2.4.28";
    static final String VERSION_HEADER = "X-JK-App-Version";

    static final int JSON_TIMEOUT_MS = 20_000;
    static final int UPLOAD_READ_TIMEOUT_MS = 90_000;
    static final int HEALTH_TIMEOUT_MS = 10_000;
    /** A read timeout only covers one stalled read; this caps the whole exchange against a slow trickle. */
    static final long JSON_DEADLINE_MS = 60_000L;
    static final long HEALTH_DEADLINE_MS = 30_000L;
    static final long UPLOAD_DEADLINE_MS = 8L * 60_000L;

    static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    static final int MAX_PHOTO_BYTES = 12 * 1024 * 1024;
    static final int MAX_HEALTH_BYTES = 16 * 1024;

    private static final ScheduledExecutorService WATCHDOG = new ScheduledThreadPoolExecutor(1, new ThreadFactory() {
        @Override public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "jaga-http-deadline");
            thread.setDaemon(true);
            return thread;
        }
    });

    private NativeHttp() { }

    /** Connect/read timeout of a bridge request: health checks are short, every other JSON call gets 20 s. */
    static int timeoutFor(String barePath) {
        return "/api/health".equals(barePath) ? HEALTH_TIMEOUT_MS : JSON_TIMEOUT_MS;
    }

    static long deadlineFor(String barePath) {
        return "/api/health".equals(barePath) ? HEALTH_DEADLINE_MS : JSON_DEADLINE_MS;
    }

    static HttpURLConnection open(String path, String method, int connectTimeoutMs, int readTimeoutMs) throws IOException {
        URL url = new URL(ORIGIN + path);
        if (!"https".equals(url.getProtocol()) || !"jagake.bond".equals(url.getHost())) throw new SecurityException("Fixed origin required");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(connectTimeoutMs);
        connection.setReadTimeout(readTimeoutMs);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty(VERSION_HEADER, APP_VERSION);
        return connection;
    }

    /** Disconnects the connection when the deadline passes; close() (try-with-resources) cancels it. */
    static final class Deadline implements AutoCloseable {
        private final ScheduledFuture<?> task;

        Deadline(final HttpURLConnection connection, long millis) {
            task = WATCHDOG.schedule(new Runnable() {
                @Override public void run() { connection.disconnect(); }
            }, millis, TimeUnit.MILLISECONDS);
        }

        @Override public void close() { task.cancel(false); }
    }

    /** @throws IOException when the stream holds more than {@code limit} bytes. */
    static byte[] readBounded(InputStream stream, int limit) throws IOException {
        if (stream == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = stream.read(buffer)) != -1) {
            if (out.size() + count > limit) throw new IOException("Response exceeds size limit");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
}

