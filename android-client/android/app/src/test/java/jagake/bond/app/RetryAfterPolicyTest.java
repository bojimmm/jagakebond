package jagake.bond.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class RetryAfterPolicyTest {
    @Test public void positiveDeltaHonorsUpTo24Hours() {
        assertEquals(24L * 60 * 60 * 1000, RetryAfterPolicy.delayMs("86400", 1000));
    }
    @Test public void invalidAndZeroUseOneMinuteFallback() {
        assertEquals(60_000L, RetryAfterPolicy.delayMs("0", 0));
        assertEquals(60_000L, RetryAfterPolicy.delayMs("junk", 0));
        assertEquals(60_000L, RetryAfterPolicy.delayMs(null, 0));
    }
    @Test public void hugeDeltaIsCappedWithoutOverflow() {
        assertEquals(24L * 60 * 60 * 1000, RetryAfterPolicy.delayMs("999999999999999999999", 0));
    }
    @Test public void httpDateUsesFixedNowAndNeverRetriesEarly() {
        long now = java.time.Instant.parse("2025-01-01T00:00:00Z").toEpochMilli();
        assertEquals(300_000L, RetryAfterPolicy.delayMs("Wed, 01 Jan 2025 00:05:00 GMT", now));
    }
    @Test public void pastAndMalformedHttpDatesUseConservativeFallback() {
        long now = java.time.Instant.parse("2025-01-01T00:00:00Z").toEpochMilli();
        assertEquals(60_000L, RetryAfterPolicy.delayMs("Tue, 31 Dec 2024 23:59:59 GMT", now));
        assertEquals(60_000L, RetryAfterPolicy.delayMs("Wed, 99 Jan 2025 00:05:00 GMT", now));
    }
    @Test public void farFutureHttpDateIsCapped() {
        long now = java.time.Instant.parse("2025-01-01T00:00:00Z").toEpochMilli();
        assertEquals(24L * 60 * 60 * 1000, RetryAfterPolicy.delayMs("Fri, 01 Jan 2038 00:00:00 GMT", now));
    }
    @Test public void timestampAdditionSaturates() {
        assertEquals(Long.MAX_VALUE, RetryAfterPolicy.nextAttemptMs(Long.MAX_VALUE - 5, 60_000));
    }
}
