package jagake.bond.app;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.UUID;

/** {@link UploadEngine.Transport} over HttpURLConnection: streams the multipart body with a fixed length and bounded timeouts. */
final class HttpTransport implements UploadEngine.Transport {
    @Override public UploadEngine.Response health() throws IOException {
        HttpURLConnection connection = NativeHttp.open("/api/health", "GET", NativeHttp.HEALTH_TIMEOUT_MS, NativeHttp.HEALTH_TIMEOUT_MS);
        try (NativeHttp.Deadline ignored = new NativeHttp.Deadline(connection, NativeHttp.HEALTH_DEADLINE_MS)) {
            return read(connection, NativeHttp.MAX_HEALTH_BYTES);
        } finally {
            connection.disconnect();
        }
    }

    @Override public UploadEngine.Response upload(JSONObject session, JSONObject fields, String requestId, byte[] image) throws IOException {
        String boundary = "Jaga" + UUID.randomUUID().toString().replace("-", "");
        Multipart multipart = Multipart.build(boundary, CaptureFields.NAMES, fields, requestId);
        HttpURLConnection connection = NativeHttp.open("/api/analyze", "POST", NativeHttp.JSON_TIMEOUT_MS, NativeHttp.UPLOAD_READ_TIMEOUT_MS);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(multipart.contentLength(image.length));
        connection.setRequestProperty("Content-Type", multipart.contentType());
        connection.setRequestProperty("Cookie", session.optString("cookie"));
        if (!session.optString("csrf", "").isEmpty()) connection.setRequestProperty("X-CSRF-Token", session.optString("csrf"));
        try (NativeHttp.Deadline ignored = new NativeHttp.Deadline(connection, NativeHttp.UPLOAD_DEADLINE_MS)) {
            try (OutputStream out = connection.getOutputStream()) {
                out.write(multipart.head);
                out.write(image);
                out.write(multipart.tail);
            }
            return read(connection, NativeHttp.MAX_JSON_BYTES);
        } finally {
            connection.disconnect();
        }
    }

    private static UploadEngine.Response read(HttpURLConnection connection, int limit) throws IOException {
        int status = connection.getResponseCode();
        String retryAfter = connection.getHeaderField("Retry-After");
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        try {
            return new UploadEngine.Response(status, retryAfter, NativeHttp.readBounded(stream, limit));
        } finally {
            if (stream != null) stream.close();
        }
    }
}
