package jagake.bond.app;

import org.json.JSONObject;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.*;

public class CookieSessionTest {
    @Test public void requiresActualSessionCookieWithExpiry() throws Exception {
        assertFalse(JagaSyncPlugin.validSessionCookie("jk_csrf=csrf; Path=/"));
        assertFalse(JagaSyncPlugin.validSessionCookie("jk_session=; Max-Age=3600"));
        assertFalse(JagaSyncPlugin.validSessionCookie("jk_session=opaque; Max-Age=-1"));
        assertTrue(JagaSyncPlugin.validSessionCookie("jk_session=opaque; Max-Age=3600; Path=/\njk_csrf=token; Path=/"));
    }

    @Test public void responseBodyCanBeBoundedAndApi24Compatible() throws Exception {
        byte[] response = "ok-é".getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(response, NativeHttp.readBounded(new ByteArrayInputStream(response), 16));
        try {
            NativeHttp.readBounded(new ByteArrayInputStream(response), 2);
            fail("Expected response cap to reject oversized body");
        } catch (java.io.IOException expected) { }
    }
}