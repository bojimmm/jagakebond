package jagake.bond.app;

import org.json.JSONObject;

import java.util.regex.Pattern;

final class SyncStatusPolicy {
    private static final Pattern HEALTH_HTTP = Pattern.compile("health_http_[0-9]{3}");

    private SyncStatusPolicy() { }

    /**
     * A blocked draft that "Sinkronkan" / opening the app may try again. {@code account_mismatch} is deliberately
     * not here: it is released by the next sign-in of that account, not by a sync.
     */
    static boolean retryOnExplicitSync(String status, String error) {
        return "blocked".equals(status)
                && ("server_update_required".equals(error) || "authentication_required".equals(error)
                || isHealthHttpError(error));
    }

    /**
     * A failed draft whose failure was on the network or server side (not the draft's own fault) is retried by an
     * explicit sync. {@code retry_limit_reached} is what releases up to 0.2.1.x wrote after about an hour of patchy signal.
     */
    static boolean revivesOnExplicitSync(String status, String error) {
        return "failed".equals(status)
                && ("retry_limit_reached".equals(error) || "server_failures".equals(error) || "store_error".equals(error));
    }

    static boolean scheduleOnExplicitSync(String status, String error) {
        return "pending".equals(status) || retryOnExplicitSync(status, error) || revivesOnExplicitSync(status, error);
    }

    /** Any 4xx/5xx answer of the health pre-check is recoverable: the server may be fixed or redeployed. */
    static boolean isHealthHttpError(String error) {
        return error != null && HEALTH_HTTP.matcher(error).matches();
    }

    static String healthDecision(int status, String body) {
        if (status != 200) return "http_" + status;
        try {
            org.json.JSONTokener tokener = new org.json.JSONTokener(body == null ? "" : body);
            Object parsed = tokener.nextValue();
            if (!(parsed instanceof JSONObject) || tokener.nextClean() != 0) return "retry";
            Object rawVersion = ((JSONObject) parsed).opt("version");
            if (!(rawVersion instanceof String)) return "retry";
            String version = (String) rawVersion;
            if (!validVersion(version)) return "retry";
            return UploadPolicy.compatibleVersion(version) ? "compatible" : "incompatible";
        } catch (Exception ignored) {
            return "retry";
        }
    }

    static String healthError(int status) {
        return status == 200 ? "health_invalid_response" : "health_http_" + status;
    }

    static String healthDecision(int status, String body, boolean needsTreeContinuity) {
        String decision = healthDecision(status, body);
        if (!needsTreeContinuity || !"compatible".equals(decision)) return decision;
        try {
            JSONObject capabilities = new JSONObject(body).optJSONObject("capabilities");
            return capabilities != null && Boolean.TRUE.equals(capabilities.opt("treeContinuity"))
                    ? "compatible" : "incompatible";
        } catch (Exception ignored) { return "retry"; }
    }

    private static boolean validVersion(String version) {
        if (version == null || version.isEmpty()) return false;
        int suffixAt = version.indexOf('-');
        int buildAt = version.indexOf('+');
        if (suffixAt < 0 || (buildAt >= 0 && buildAt < suffixAt)) suffixAt = buildAt;
        String core = suffixAt < 0 ? version : version.substring(0, suffixAt);
        if (suffixAt >= 0) {
            String suffix = version.substring(suffixAt + 1);
            if (suffix.isEmpty()) return false;
            for (int i = 0; i < suffix.length(); i++) {
                char ch = suffix.charAt(i);
                if (!(Character.isLetterOrDigit(ch) || ch == '.' || ch == '-')) return false;
            }
        }
        String[] parts = core.split("[.]", -1);
        if (parts.length != 2 && parts.length != 3) return false;
        for (String part : parts) {
            if (part.isEmpty()) return false;
            for (int i = 0; i < part.length(); i++) if (!Character.isDigit(part.charAt(i))) return false;
        }
        return true;
    }

}
