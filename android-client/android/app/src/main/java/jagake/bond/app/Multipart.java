package jagake.bond.app;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The multipart body of {@code POST /api/analyze} split into head (text parts and the image part header) and tail,
 * so the upload can stream head + photo bytes + tail with a fixed length instead of buffering a copy of the whole body.
 */
final class Multipart {
    final String boundary;
    final byte[] head;
    final byte[] tail;

    private Multipart(String boundary, byte[] head, byte[] tail) {
        this.boundary = boundary;
        this.head = head;
        this.tail = tail;
    }

    static Multipart build(String boundary, String[] names, JSONObject fields, String requestId) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        for (String name : names) {
            if (!fields.isNull(name)) part(out, boundary, name, fields.optString(name));
        }
        part(out, boundary, "clientRequestId", requestId);
        out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n");
        return new Multipart(boundary, bytes.toByteArray(), ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    long contentLength(int imageLength) { return (long) head.length + imageLength + tail.length; }

    String contentType() { return "multipart/form-data; boundary=" + boundary; }

    static void part(DataOutputStream out, String boundary, String name, String value) throws IOException {
        out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.writeBytes("\r\n");
    }
}
