package jagake.bond.app;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertArrayEquals;

public class MultipartEncodingTest {
    @Test public void multipartTextUsesUtf8WithoutLoss() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        Multipart.part(out, "boundary123", "locationName", "Kebun Cengkeh — Maluku");
        byte[] expected = ("--boundary123\r\nContent-Disposition: form-data; name=\"locationName\"\r\n\r\nKebun Cengkeh — Maluku\r\n").getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(expected, bytes.toByteArray());
    }
}
