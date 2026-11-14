package jagake.bond.app;

import java.lang.reflect.Field;
import java.util.Arrays;
import org.junit.Test;
import static org.junit.Assert.assertTrue;

public class TreeContinuityTest {
    @Test public void oldServerCannotSilentlyDropTreeIdentity() {
        assertTrue("Old backend must block linked capture", "incompatible".equals(
            SyncStatusPolicy.healthDecision(200, "{\"version\":\"2.1.0\"}", true)));
        assertTrue("Tree-capable backend accepts linked capture", "compatible".equals(
            SyncStatusPolicy.healthDecision(200, "{\"version\":\"2.1.0\",\"capabilities\":{\"treeContinuity\":true}}", true)));
        assertTrue("Unlinked legacy capture is still supported", "compatible".equals(
            SyncStatusPolicy.healthDecision(200, "{\"version\":\"2.1.0\"}", false)));
    }
    @Test public void durableDraftFieldsRetainTreeIdentityAndDisplayName() throws Exception {
        Field field = JagaSyncPlugin.class.getDeclaredField("FIELDS");
        field.setAccessible(true);
        String[] fields = (String[]) field.get(null);
        assertTrue("Tree ID must survive encrypted draft persistence", Arrays.asList(fields).contains("cropId"));
        assertTrue("Tree name must survive offline review", Arrays.asList(fields).contains("cropName"));
    }
}
