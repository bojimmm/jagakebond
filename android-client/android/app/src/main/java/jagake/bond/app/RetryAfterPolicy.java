package jagake.bond.app;

import java.math.BigInteger;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Pure Retry-After policy; unsupported values fall back safely. */
final class RetryAfterPolicy {
    static final long FALLBACK_MS = 60_000L;
    static final long MAX_DELAY_MS = 24L * 60 * 60 * 1000;
    private static final BigInteger MAX_SECONDS = BigInteger.valueOf(MAX_DELAY_MS / 1000);

    private RetryAfterPolicy() {}

    static long delayMs(String value, long nowMs) {
        if (value == null) return FALLBACK_MS;
        String normalized = value.trim();
        if (normalized.matches("[0-9]+")) {
            try {
                BigInteger seconds = new BigInteger(normalized);
                if (seconds.signum() <= 0) return FALLBACK_MS;
                if (seconds.compareTo(MAX_SECONDS) > 0) return MAX_DELAY_MS;
                return seconds.longValue() * 1000L;
            } catch (NumberFormatException e) {
                return FALLBACK_MS;
            }
        }
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setLenient(false);
        format.setTimeZone(TimeZone.getTimeZone("GMT"));
        ParsePosition position = new ParsePosition(0);
        Date retryAt = format.parse(normalized, position);
        if (retryAt == null || position.getIndex() != normalized.length()) return FALLBACK_MS;
        BigInteger delay = BigInteger.valueOf(retryAt.getTime()).subtract(BigInteger.valueOf(nowMs));
        if (delay.signum() <= 0) return FALLBACK_MS;
        BigInteger cap = BigInteger.valueOf(MAX_DELAY_MS);
        return delay.compareTo(cap) > 0 ? MAX_DELAY_MS : delay.longValue();
    }

    static long nextAttemptMs(long nowMs, long delayMs) {
        if (delayMs <= 0) return nowMs;
        return nowMs > Long.MAX_VALUE - delayMs ? Long.MAX_VALUE : nowMs + delayMs;
    }
}
