package jagake.bond.app;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class UploadReceiptTest {
    @Test public void acceptedResponseMustContainAJobId() {
        String good = "{\"job_id\":\"job_abc\",\"status\":\"queued\"}";
        assertTrue(UploadPolicy.validReceipt(good));
        assertFalse(UploadPolicy.validReceipt("{\"status\":\"queued\"}"));
        assertFalse(UploadPolicy.validReceipt("{\"job_id\":\"\"}"));
        assertFalse(UploadPolicy.validReceipt("{\"job_id\":\"bad/id\"}"));
        assertFalse(UploadPolicy.validReceipt("not-json"));
        assertFalse(UploadPolicy.validReceipt("{\"job_id\":12}"));
        assertFalse(UploadPolicy.validReceipt("{\"job_id\":{\"nested\":\"job_abc\"}}"));
        assertFalse(UploadPolicy.validReceipt("{\"job_id\":\"\",\"extra\":{\"job_id\":\"nested\"}}"));
        assertEquals("submitted", UploadPolicy.responseDecision(200, good));
        assertEquals("invalid_receipt", UploadPolicy.responseDecision(200, "{}"));
        assertEquals("blocked", UploadPolicy.responseDecision(401, "{}"));
        assertEquals("conflict", UploadPolicy.responseDecision(409, "{}"));
        assertEquals("retry", UploadPolicy.responseDecision(429, "{}"));
    }

    @Test public void draftOwnershipCannotCommitAcrossAccountSwitch() {
        assertTrue(UploadPolicy.stillOwnsDraft("acctA", "acctA", 3, 3, true));
        assertFalse(UploadPolicy.stillOwnsDraft("acctB", "acctA", 4, 3, true));
        assertFalse(UploadPolicy.stillOwnsDraft("acctA", "acctA", 3, 3, false));
    }

    @Test public void credentialPostRequiresCurrentOwnerGenerationUploadingDraftAndSession() {
        assertTrue(UploadPolicy.readyForPost("acctA", "acctA", 3, 3, "uploading", true));
        assertFalse(UploadPolicy.readyForPost("acctB", "acctA", 4, 3, "uploading", true));
        assertFalse(UploadPolicy.readyForPost("acctA", "acctA", 4, 3, "uploading", true));
        assertFalse(UploadPolicy.readyForPost("acctA", "acctA", 3, 3, "pending", true));
        assertFalse(UploadPolicy.readyForPost("acctA", "acctA", 3, 3, "submitted", true));
        assertFalse(UploadPolicy.readyForPost("acctA", "acctA", 3, 3, "uploading", false));
    }

    @Test public void backendGateRequiresSupportedSemanticVersionAndFailsClosed() {
        assertTrue(UploadPolicy.compatibleVersion("2.1.0"));
        assertTrue(UploadPolicy.compatibleVersion("2.4.7"));
        assertFalse(UploadPolicy.compatibleVersion("2.0.9"));
        assertFalse(UploadPolicy.compatibleVersion("3.0.0"));
        assertFalse(UploadPolicy.compatibleVersion("unknown"));
        assertFalse(UploadPolicy.compatibleVersion("2.1"));
        assertFalse(UploadPolicy.compatibleVersion(""));
    }

    @Test public void multipartValueIsUtf8() {
        assertArrayEquals("Kebun Cengkeh — Maluku".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                UploadPolicy.utf8("Kebun Cengkeh — Maluku"));
    }
}
