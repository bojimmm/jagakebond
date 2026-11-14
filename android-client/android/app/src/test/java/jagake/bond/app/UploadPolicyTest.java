package jagake.bond.app;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class UploadPolicyTest {
    @Test public void backoffDoublesFromThirtySecondsAndStopsAtOneHour() {
        long[] expected = {30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000};
        for (int i = 0; i < expected.length; i++) assertEquals("failure " + (i + 1), expected[i], UploadPolicy.backoffMs(i + 1));
        assertEquals(30_000, UploadPolicy.backoffMs(0));
        assertEquals(3_600_000, UploadPolicy.backoffMs(Integer.MAX_VALUE));
        assertEquals(3_600_000, UploadPolicy.backoffMs(1000));
    }

    @Test public void uploadStatusesMapToTheContractedOutcomes() {
        long now = 1_000_000L;
        assertEquals(UploadPolicy.Decision.Kind.SUBMITTED, UploadPolicy.forUpload(200, null, "{\"job_id\":\"j1\"}", now).kind);
        assertEquals(UploadPolicy.Decision.Kind.SERVER, UploadPolicy.forUpload(200, null, "{}", now).kind);
        assertEquals("photo_too_large", UploadPolicy.forUpload(413, null, "", now).error);
        assertEquals(UploadPolicy.Decision.Kind.DEFER, UploadPolicy.forUpload(429, "30", "", now).kind);
        assertEquals(30_000, UploadPolicy.forUpload(429, "30", "", now).deferMs);
        assertEquals(UploadPolicy.Decision.Kind.DEFER, UploadPolicy.forUpload(503, "5", "", now).kind);
        assertEquals(UploadPolicy.Decision.Kind.SERVER, UploadPolicy.forUpload(503, "  ", "", now).kind);
        assertEquals(UploadPolicy.Decision.Kind.SERVER, UploadPolicy.forUpload(500, null, "", now).kind);
        assertEquals(UploadPolicy.Decision.Kind.NETWORK, UploadPolicy.forUpload(408, null, "", now).kind);
        assertEquals(UploadPolicy.Decision.Kind.NETWORK, UploadPolicy.forUpload(301, null, "", now).kind);
        assertEquals("account_mismatch", UploadPolicy.forUpload(409, null, "{\"code\":\"account_mismatch\"}", now).error);
        assertEquals("idempotency_conflict", UploadPolicy.forUpload(409, null, "not json", now).error);
        assertEquals("http_404", UploadPolicy.forUpload(404, null, "", now).error);
    }

    @Test public void healthDecisionsMapToOutcomes() {
        long now = 5;
        assertNull(UploadPolicy.forHealth("compatible", null, now));
        assertEquals("server_update_required", UploadPolicy.forHealth("incompatible", null, now).error);
        assertEquals("health_invalid_response", UploadPolicy.forHealth("retry", null, now).error);
        assertEquals("health_http_403", UploadPolicy.forHealth("http_403", null, now).error);
        assertEquals(UploadPolicy.Decision.Kind.BLOCKED, UploadPolicy.forHealth("http_422", null, now).kind);
        assertEquals(UploadPolicy.Decision.Kind.SERVER, UploadPolicy.forHealth("http_502", null, now).kind);
        assertEquals(UploadPolicy.Decision.Kind.DEFER, UploadPolicy.forHealth("http_503", "10", now).kind);
        assertEquals(UploadPolicy.Decision.Kind.NETWORK, UploadPolicy.forHealth("http_302", null, now).kind);
    }

    @Test public void applyKeepsCountersAndStatusesConsistent() throws Exception {
        JSONObject row = new JSONObject().put("status", "uploading").put("netFails", 3);
        UploadPolicy.Decision.server("http_500").apply(row, 1000);
        assertFalse("a server answer proves the network works", row.has("netFails"));
        assertEquals(1, row.getInt("srvFails"));
        UploadPolicy.Decision.submitted("job_1").apply(row, 2000);
        assertEquals("submitted", row.getString("status"));
        assertFalse(row.has("srvFails") || row.has("srvFirstMs") || row.has("error"));
        // A forgotten streak (older than a week) starts over.
        JSONObject old = new JSONObject().put("srvFails", 9).put("srvFirstMs", 1L);
        UploadPolicy.Decision.server("http_500").apply(old, 8L * 24 * 3600 * 1000);
        assertEquals(1, old.getInt("srvFails"));
        assertEquals("pending", old.getString("status"));
    }

    @Test public void reasonsAreCleanedAndCapped() {
        assertEquals("a b c", UploadPolicy.cleanDetail("  a\n\tb \u0007 c  "));
        assertEquals("", UploadPolicy.cleanDetail("\n\n"));
        assertTrue(UploadPolicy.cleanDetail("x".repeat(500)).length() <= UploadPolicy.MAX_DETAIL_CHARS);
        String emoji = "😀".repeat(100);
        String capped = UploadPolicy.cleanDetail(emoji);
        assertFalse("never ends in half a surrogate pair", Character.isHighSurrogate(capped.charAt(capped.length() - 1)));
        assertEquals("invalid_request", UploadPolicy.invalidReason("{\"detail\":\"\"}"));
        assertEquals("invalid:Foto buruk", UploadPolicy.invalidReason("{\"detail\":\"Foto buruk\"}"));
    }

    @Test public void multipartBodyIsExactlyHeadPhotoTailWithAFixedLength() throws Exception {
        JSONObject fields = new JSONObject().put("lat", "-6.2").put("lng", "106.8").put("cropId", JSONObject.NULL)
                .put("locationName", "Kebun Cengkeh — Maluku");
        Multipart multipart = Multipart.build("BOUND", CaptureFields.NAMES, fields, "req-1");
        byte[] photo = TestSupport.randomBytes(1234, 1);
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(multipart.head);
        body.write(photo);
        body.write(multipart.tail);
        assertEquals(body.size(), multipart.contentLength(photo.length));
        String text = new String(body.toByteArray(), StandardCharsets.ISO_8859_1);
        assertTrue(text.startsWith("--BOUND\r\nContent-Disposition: form-data; name=\"lat\"\r\n\r\n-6.2\r\n"));
        assertFalse("null fields are not sent", text.contains("name=\"cropId\""));
        assertTrue(text.indexOf("name=\"lat\"") < text.indexOf("name=\"lng\""));
        assertTrue(text.indexOf("name=\"lng\"") < text.indexOf("name=\"locationName\""));
        assertTrue(text.contains("name=\"clientRequestId\"\r\n\r\nreq-1\r\n"));
        assertTrue(text.contains("name=\"image\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"));
        assertTrue(text.endsWith("\r\n--BOUND--\r\n"));
        assertEquals("multipart/form-data; boundary=BOUND", multipart.contentType());
        // The existing UTF-8 text part encoding is preserved.
        ByteArrayOutputStream part = new ByteArrayOutputStream();
        Multipart.part(new DataOutputStream(part), "B", "n", "—");
        assertTrue(new String(part.toByteArray(), StandardCharsets.UTF_8).contains("—"));
    }
}
