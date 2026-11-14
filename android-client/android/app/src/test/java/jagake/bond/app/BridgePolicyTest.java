package jagake.bond.app;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class BridgePolicyTest {
    @Test public void inputReferenceRouteIsPostOnlyAndNarrow() {
        assertTrue(JagaSyncPlugin.allowed("/api/recommendations", "POST"));
        assertTrue(JagaSyncPlugin.allowed("/api/client-errors", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/client-errors", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/client-errors?x=1", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/recommendations", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/recommendations/other", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/recommendations?recordId=other", "POST"));
    }

    @Test public void permitsOnlyRealFarmerApiRoutesAndMethods() {
        assertTrue(JagaSyncPlugin.allowed("/api/auth/me", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/health", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/health", "POST"));
        assertTrue(JagaSyncPlugin.allowed("/api/telemetry?lat=-6.2&lng=106.8", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/daily", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/analyze", "POST"));
        assertTrue(JagaSyncPlugin.allowed("/api/records/record_123/reanalyze", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/record_123/reanalyze", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/record_123/reanalyze?photo=other", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/record_123/other", "POST"));
        assertTrue(JagaSyncPlugin.allowed("/api/photos/photo_123", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/photos/photo_123/thumbnail", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/photos/photo_123/thumbnail", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/photos/photo_123/thumbnail?size=full", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/farms/farm_1", "PUT"));
        assertTrue(JagaSyncPlugin.allowed("/api/queue/pending", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/analyze/job_123/cancel", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/analyze/job_123/cancel", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/queue/next", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/analyze/job_123/result", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/photos", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/login", "GET"));
    }

    @Test public void acceptsContractOpaqueIdsIncludingShortStablePhotoIds() {
        assertTrue(JagaSyncPlugin.validId("p1"));
        assertTrue(JagaSyncPlugin.validId("a".repeat(128)));
        assertFalse(JagaSyncPlugin.validId("../photo"));
        assertFalse(JagaSyncPlugin.validId("a".repeat(129)));
    }

    @Test public void rejectsUntrustedOriginsTraversalAndHeaderInjection() {
        assertFalse(JagaSyncPlugin.allowed("https://jagake.bond/api/auth/me", "GET"));
        assertFalse(JagaSyncPlugin.allowed("//evil.example/api/auth/me", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/../admin", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/%2e%2e/admin", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/%2fadmin", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/me\r\nHost: evil.example", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/me#fragment", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/auth/me?next=https://evil.example", "GET"));
    }

    @Test public void validatesAccountNamespaceAndOpaqueId() {
        assertTrue(JagaSyncPlugin.validAccount("acct_1-2"));
        assertFalse(JagaSyncPlugin.validAccount("../acct"));
        assertFalse(JagaSyncPlugin.validAccount(""));
    }

    @Test public void recordsPagingQueryIsAllowedForGetOnly() {
        assertTrue(JagaSyncPlugin.allowed("/api/records", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/records?limit=200", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/records?limit=200&cursor=abc123", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/records?cursor=abc&limit=500", "GET"));
        assertTrue("an opaque base64url cursor", JagaSyncPlugin.allowed("/api/records?limit=200&cursor=eyJ0IjoxNzAwfQ_-x", "GET"));
        assertTrue("a standard base64 cursor, URL-encoded: %2F and %3D are legitimate here", JagaSyncPlugin.allowed("/api/records?limit=200&cursor=ab%2Fcd%3D%3D", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/records?limit=200&cursor=ab/cd+ef==", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/records", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/records?limit=200", "DELETE"));
    }

    @Test public void recordsPagingQueryRejectsAnythingElse() {
        for (String bad : new String[]{
                "/api/records?limit=0", "/api/records?limit=501", "/api/records?limit=abc", "/api/records?limit=",
                "/api/records?limit=1&limit=2", "/api/records?cursor=", "/api/records?cursor=a&cursor=b",
                "/api/records?other=1", "/api/records?limit=5&admin=1", "/api/records?cursor=a%2", "/api/records?cursor=a%zz",
                "/api/records?cursor=a b", "/api/records?cursor=a..b", "/api/records?cursor=a\b", "/api/records?cursor=a#b",
                "/api/records?cursor=a@b", "/api/records?cursor=" + "x".repeat(1025), "/api/records?", "/api/records?&limit=5",
                "/api/records?limit=5\r\nX: y"}) {
            assertFalse(bad, JagaSyncPlugin.allowed(bad, "GET"));
        }
        assertFalse("paths keep their strict checks", JagaSyncPlugin.allowed("/api/records/%2e%2e?limit=5", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/records/abc?limit=5", "GET"));
        assertTrue("the generic routes keep accepting their free-form queries", JagaSyncPlugin.allowed("/api/telemetry?lat=-6.2&lng=106.8", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/telemetry?x=%2f", "GET"));
    }

    @Test public void dailyNoteDeleteIsAllowedAsBefore() {
        assertTrue(JagaSyncPlugin.allowed("/api/daily/note_1", "DELETE"));
    }
}
