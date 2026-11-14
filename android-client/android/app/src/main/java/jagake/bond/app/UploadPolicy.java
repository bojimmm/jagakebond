package jagake.bond.app;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Pure rules of the native upload: what a server answer means for a draft, how long to wait before the next attempt,
 * and when a draft may finally be called {@code failed}. No Android classes, so every rule is covered by JVM tests.
 *
 * <p>Retry policy (audit M-3):
 * <ul>
 *   <li>Network failures and timeouts never fail a draft. They back off 30 s, 1 min, 2 min ... capped at 1 hour and keep
 *       going for as long as it takes.</li>
 *   <li>Only server-attributed failures (5xx, an unusable receipt) count. A draft becomes {@code failed} after at least
 *       {@value #SERVER_FAILURE_MIN_COUNT} of them spread over at least 24 hours, so a short outage never fails it.</li>
 *   <li>429, and 503 with Retry-After, are the server asking for time: defer by Retry-After, never counted.</li>
 *   <li>413, 422 and other 4xx are permanent for that draft, with a reason the farmer can read.</li>
 *   <li>401/403 and 409 account_mismatch block the draft until the account signs in again.</li>
 * </ul>
 */
final class UploadPolicy {
    static final long BACKOFF_BASE_MS = 30_000L;
    static final long BACKOFF_CAP_MS = 60L * 60 * 1000;
    static final int SERVER_FAILURE_MIN_COUNT = 10;
    static final long SERVER_FAILURE_MIN_SPAN_MS = 24L * 60 * 60 * 1000;
    /** A server-failure streak older than this is forgotten (sporadic failures must not add up forever). */
    static final long SERVER_STREAK_WINDOW_MS = 7L * 24 * 60 * 60 * 1000;
    static final int MAX_DETAIL_CHARS = 160;

    private static final Pattern JOB_ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern VERSION = Pattern.compile("^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$");

    private UploadPolicy() { }

    // ------------------------------------------------------------------ receipts, versions, ownership

    static boolean validReceipt(String json) {
        if (json == null) return false;
        try {
            Object jobId = new JSONObject(json).opt("job_id");
            return jobId instanceof String && JOB_ID.matcher((String) jobId).matches();
        } catch (org.json.JSONException e) {
            return false;
        }
    }

    /** Coarse first-level classification of a server answer to the upload. */
    static String responseDecision(int status, String body) {
        if (status == 401 || status == 403) return "blocked";
        if (status == 409) return "conflict";
        if (status == 429 || status >= 500 || status == 408) return "retry";
        if (status < 200 || status >= 300) return "failed";
        return validReceipt(body) ? "submitted" : "invalid_receipt";
    }

    static boolean compatibleBackend(String json) {
        try { return compatibleVersion(new JSONObject(json).optString("version", "")); }
        catch (Exception e) { return false; }
    }

    static boolean compatibleVersion(String version) {
        if (version == null || !VERSION.matcher(version).matches()) return false;
        String[] components = version.split("[.+-]", 4);
        try { return Integer.parseInt(components[0]) == 2 && Integer.parseInt(components[1]) >= 1; }
        catch (NumberFormatException e) { return false; }
    }

    static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    static boolean stillOwnsDraft(String activeAccount, String expectedAccount, long activeGeneration,
                                  long expectedGeneration, boolean draftExists) {
        return draftExists && expectedAccount.equals(activeAccount) && expectedGeneration == activeGeneration;
    }

    static boolean uploadStartAllowed(String status) {
        return "pending".equals(status) || "uploading".equals(status) || "blocked".equals(status);
    }

    static boolean readyForPost(String activeAccount, String expectedAccount, long activeGeneration,
                                long expectedGeneration, String status, boolean sessionExists) {
        return sessionExists && "uploading".equals(status)
                && stillOwnsDraft(activeAccount, expectedAccount, activeGeneration, expectedGeneration, true);
    }

    // ------------------------------------------------------------------ retry timing

    /** Wait after the n-th consecutive failure (n >= 1): 30 s, 1 min, 2 min ... capped at 1 h. */
    static long backoffMs(int failures) {
        int shift = Math.max(0, Math.min(failures - 1, 12));
        return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS << shift);
    }

    // ------------------------------------------------------------------ outcome of one attempt

    /** What one attempt means for the draft row. {@link #apply} writes it into the live row and decides the next attempt. */
    static final class Decision {
        enum Kind { SUBMITTED, FAILED, BLOCKED, DEFER, NETWORK, SERVER }

        final Kind kind;
        final String error;
        final String jobId;
        final long deferMs;
        /** The server's 429 {@code code} (one of {@link #SERVER_CODES}), kept on the row as {@code serverCode}; or null. */
        final String serverCode;
        /** Set by {@link #apply}: wait before the next attempt, or -1 when nothing is to be scheduled. */
        long scheduleDelayMs = -1;
        /** Set by {@link #apply}: the status the row ended in. */
        String resultStatus;

        private Decision(Kind kind, String error, String jobId, long deferMs) {
            this(kind, error, jobId, deferMs, null);
        }

        private Decision(Kind kind, String error, String jobId, long deferMs, String serverCode) {
            this.kind = kind;
            this.error = error;
            this.jobId = jobId;
            this.deferMs = deferMs;
            this.serverCode = serverCode;
        }

        static Decision submitted(String jobId) { return new Decision(Kind.SUBMITTED, null, jobId, 0); }

        static Decision failed(String error) { return new Decision(Kind.FAILED, error, null, 0); }

        static Decision blocked(String error) { return new Decision(Kind.BLOCKED, error, null, 0); }

        static Decision defer(String error, long delayMs) { return new Decision(Kind.DEFER, error, null, delayMs); }

        static Decision defer(String error, long delayMs, String serverCode) {
            return new Decision(Kind.DEFER, error, null, delayMs, serverCode);
        }

        static Decision network() { return new Decision(Kind.NETWORK, "network_retry", null, 0); }

        static Decision server(String error) { return new Decision(Kind.SERVER, error, null, 0); }

        void apply(JSONObject row, long now) throws Exception {
            row.remove("serverCode");
            switch (kind) {
                case SUBMITTED:
                    row.put("status", "submitted");
                    row.remove("error");
                    row.remove("nextAttemptAtMs");
                    if (jobId != null && !jobId.isEmpty()) row.put("jobId", jobId);
                    clearCounters(row);
                    resultStatus = "submitted";
                    break;
                case FAILED:
                    row.put("status", "failed");
                    row.put("error", error);
                    row.remove("nextAttemptAtMs");
                    resultStatus = "failed";
                    break;
                case BLOCKED:
                    row.put("status", "blocked");
                    row.put("error", error);
                    row.remove("nextAttemptAtMs");
                    resultStatus = "blocked";
                    break;
                case DEFER:
                    row.put("status", "pending");
                    row.put("error", error);
                    row.put("nextAttemptAtMs", RetryAfterPolicy.nextAttemptMs(now, deferMs));
                    if (serverCode != null) row.put("serverCode", serverCode);
                    row.remove("netFails");
                    scheduleDelayMs = deferMs;
                    resultStatus = "pending";
                    break;
                case NETWORK: {
                    int failures = row.optInt("netFails", 0) + 1;
                    long wait = backoffMs(failures);
                    row.put("netFails", failures);
                    row.put("status", "pending");
                    row.put("error", error);
                    row.put("nextAttemptAtMs", now + wait);
                    scheduleDelayMs = wait;
                    resultStatus = "pending";
                    break;
                }
                case SERVER: {
                    long first = row.optLong("srvFirstMs", 0);
                    int failures = row.optInt("srvFails", 0);
                    if (first == 0 || now - first > SERVER_STREAK_WINDOW_MS) {
                        first = now;
                        failures = 0;
                    }
                    failures++;
                    row.put("srvFails", failures);
                    row.put("srvFirstMs", first);
                    row.remove("netFails");
                    if (failures >= SERVER_FAILURE_MIN_COUNT && now - first >= SERVER_FAILURE_MIN_SPAN_MS) {
                        row.put("status", "failed");
                        row.put("error", "server_failures");
                        row.remove("nextAttemptAtMs");
                        resultStatus = "failed";
                    } else {
                        long wait = backoffMs(failures);
                        row.put("status", "pending");
                        row.put("error", error);
                        row.put("nextAttemptAtMs", now + wait);
                        scheduleDelayMs = wait;
                        resultStatus = "pending";
                    }
                    break;
                }
                default:
                    throw new IllegalStateException(String.valueOf(kind));
            }
        }
    }

    static void clearCounters(JSONObject row) {
        row.remove("netFails");
        row.remove("srvFails");
        row.remove("srvFirstMs");
    }

    /** Decision for the answer to {@code POST /api/analyze}. */
    static Decision forUpload(int status, String retryAfter, String body, long now) {
        if (status >= 200 && status < 300) {
            return validReceipt(body) ? Decision.submitted(jobIdOf(body)) : Decision.server("invalid_receipt");
        }
        switch (status) {
            case 401:
            case 403:
                return Decision.blocked("authentication_required");
            case 409:
                return "account_mismatch".equals(codeOf(body)) ? Decision.blocked("account_mismatch") : Decision.failed("idempotency_conflict");
            case 413:
                return Decision.failed("photo_too_large");
            case 422:
                return Decision.failed(invalidReason(body));
            case 429:
                return Decision.defer("rate_limited", RetryAfterPolicy.delayMs(retryAfter, now), serverCode(body));
            case 503:
                if (hasValue(retryAfter)) return Decision.defer("server_busy", RetryAfterPolicy.delayMs(retryAfter, now));
                return Decision.server("http_503");
            case 408:
            case 425:
                return Decision.network();
            default:
                break;
        }
        if (status >= 300 && status < 400) return Decision.network();
        if (status >= 500) return Decision.server("http_" + status);
        return Decision.failed("http_" + status);
    }

    /**
     * Decision for the pre-flight {@code GET /api/health}.
     *
     * @param healthDecision result of {@link SyncStatusPolicy#healthDecision}
     * @return null when the server is compatible and the upload may proceed
     */
    static Decision forHealth(String healthDecision, String retryAfter, long now) {
        if ("compatible".equals(healthDecision)) return null;
        if ("incompatible".equals(healthDecision)) return Decision.blocked("server_update_required");
        if (healthDecision != null && healthDecision.startsWith("http_")) {
            int status;
            try { status = Integer.parseInt(healthDecision.substring(5)); }
            catch (NumberFormatException e) { return Decision.server("health_invalid_response"); }
            String error = SyncStatusPolicy.healthError(status);
            if (status == 429) return Decision.defer("rate_limited", RetryAfterPolicy.delayMs(retryAfter, now));
            if (status == 503 && hasValue(retryAfter)) return Decision.defer("server_busy", RetryAfterPolicy.delayMs(retryAfter, now));
            if (status == 408 || status == 425 || (status >= 300 && status < 400)) return Decision.network();
            if (status >= 500) return Decision.server(error);
            return Decision.blocked(error);
        }
        return Decision.server("health_invalid_response");
    }

    private static boolean hasValue(String header) { return header != null && !header.trim().isEmpty(); }

    private static String jobIdOf(String body) {
        try { return new JSONObject(body).optString("job_id", ""); }
        catch (org.json.JSONException e) { return ""; }
    }

    /** 429 codes of contract 5.3; anything else is not echoed to the web. */
    static final String[] SERVER_CODES = {"queue_full", "queue_busy", "photo_quota", "decode_busy"};

    static String serverCode(String body) {
        String code = codeOf(body);
        for (String known : SERVER_CODES) if (known.equals(code)) return known;
        return null;
    }

    private static String codeOf(String body) {
        try {
            Object code = new JSONObject(body).opt("code");
            return code instanceof String ? (String) code : "";
        } catch (Exception e) {
            return "";
        }
    }

    /** {@code invalid:<server detail>} for a 422, with the detail cleaned up and capped; {@code invalid_request} without one. */
    static String invalidReason(String body) {
        try {
            Object detail = new JSONObject(body).opt("detail");
            if (detail instanceof String) {
                String clean = cleanDetail((String) detail);
                if (!clean.isEmpty()) return "invalid:" + clean;
            }
        } catch (Exception ignored) { /* not JSON: fall through */ }
        return "invalid_request";
    }

    static String cleanDetail(String detail) {
        StringBuilder out = new StringBuilder();
        boolean space = false;
        for (int i = 0; i < detail.length() && out.length() < MAX_DETAIL_CHARS; i++) {
            char c = detail.charAt(i);
            if (Character.isISOControl(c) || Character.isWhitespace(c)) {
                space = out.length() > 0;
                continue;
            }
            if (space) { out.append(' '); space = false; }
            out.append(c);
        }
        if (out.length() > MAX_DETAIL_CHARS) out.setLength(MAX_DETAIL_CHARS);
        if (out.length() > 0 && Character.isHighSurrogate(out.charAt(out.length() - 1))) out.setLength(out.length() - 1);
        return out.toString().trim();
    }
}
