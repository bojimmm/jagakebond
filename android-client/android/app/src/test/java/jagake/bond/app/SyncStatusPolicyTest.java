package jagake.bond.app;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SyncStatusPolicyTest {
    @Test public void explicitSyncRetriesOnlyKnownRecoverableBlockedReasons() {
        assertTrue(SyncStatusPolicy.retryOnExplicitSync("blocked", "server_update_required"));
        assertTrue(SyncStatusPolicy.retryOnExplicitSync("blocked", "authentication_required"));
        assertFalse(SyncStatusPolicy.retryOnExplicitSync("failed", "idempotency_conflict"));
        assertFalse(SyncStatusPolicy.retryOnExplicitSync("failed", "retry_limit_reached"));
        assertTrue(SyncStatusPolicy.retryOnExplicitSync("blocked", "health_http_403"));
        // 0.2.2.0: every health-check 4xx is recoverable on an explicit sync (was: only 403), the server may be fixed.
        assertTrue(SyncStatusPolicy.retryOnExplicitSync("blocked", "health_http_422"));
        assertFalse(SyncStatusPolicy.retryOnExplicitSync("blocked", "health_http_"));
        assertFalse(SyncStatusPolicy.retryOnExplicitSync("blocked", "account_mismatch"));
        assertFalse(SyncStatusPolicy.retryOnExplicitSync("blocked", "idempotency_conflict"));
    }

    @Test public void explicitSyncSchedulesPendingAndRecoverableBlocksWithoutResettingFailures() {
        assertTrue(SyncStatusPolicy.scheduleOnExplicitSync("pending", "rate_limited"));
        assertTrue(SyncStatusPolicy.scheduleOnExplicitSync("blocked", "server_update_required"));
        assertFalse(SyncStatusPolicy.scheduleOnExplicitSync("failed", "idempotency_conflict"));
        assertTrue(SyncStatusPolicy.scheduleOnExplicitSync("failed", "retry_limit_reached"));
        assertTrue(SyncStatusPolicy.scheduleOnExplicitSync("failed", "server_failures"));
        assertFalse(SyncStatusPolicy.scheduleOnExplicitSync("blocked", "unrecognized"));
        assertFalse(SyncStatusPolicy.scheduleOnExplicitSync("submitted", ""));
    }

    @Test public void httpHealthFailuresAreNotMisidentifiedAsVersionMismatch() {
        assertEquals("compatible", SyncStatusPolicy.healthDecision(200, versionJson("2.1.4")));
        assertEquals("incompatible", SyncStatusPolicy.healthDecision(200, versionJson("2.0.0")));
        assertEquals("incompatible", SyncStatusPolicy.healthDecision(200, versionJson("2.0")));
        assertEquals("http_403", SyncStatusPolicy.healthDecision(403, "{}"));
        assertEquals("http_503", SyncStatusPolicy.healthDecision(503, "{}"));
        assertEquals("http_408", SyncStatusPolicy.healthDecision(408, "{}"));
        assertEquals("http_429", SyncStatusPolicy.healthDecision(429, "{}"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "not-json"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "{\"version\":\"2.1.4\"} trailing"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "{\"nested\":{\"version\":\"2.1.4\"}}"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "[ {\"version\":\"2.1.4\"} ]"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "null"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "{\"version\":null}"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, "{}"));
        assertEquals("retry", SyncStatusPolicy.healthDecision(200, versionJson("unknown")));
    }

    private static String versionJson(String version) {
        return "{\"version\":\"" + version + "\"}";
    }

    @Test public void healthFailuresGetSafeSpecificCodes() {
        assertEquals("health_http_403", SyncStatusPolicy.healthError(403));
        assertEquals("health_http_503", SyncStatusPolicy.healthError(503));
        assertEquals("health_invalid_response", SyncStatusPolicy.healthError(200));
    }
}
