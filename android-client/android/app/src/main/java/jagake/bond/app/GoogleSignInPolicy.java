package jagake.bond.app;

import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;

import java.util.regex.Pattern;

/**
 * Pure rules for "Masuk dengan Google" (0.2.3.0): what {@code JagaSync.googleSignIn} accepts, how Credential Manager
 * failures map to the error codes the web app branches on, and which bridge answers open a native session.
 * Kept free of Android framework calls so the JVM unit tests cover it.
 */
final class GoogleSignInPolicy {
    /** The person closed Google's sheet: the web app shows nothing. */
    static final String CANCELLED = "google_cancelled";
    /** No Google account on this phone (or none allowed): the web app says to add one. */
    static final String NO_CREDENTIAL = "google_no_credential";
    /** Credential Manager / Google Play services missing or too old on this phone. */
    static final String UNAVAILABLE = "google_unavailable";
    /** Anything else (interrupted, unexpected credential type, parsing): "try again". */
    static final String FAILED = "google_failed";
    /** The web app sent something that is not a client id / nonce. */
    static final String INVALID = "google_invalid_request";

    static final String SIGN_IN_PATH = "/api/auth/google";

    private static final Pattern CLIENT_ID = Pattern.compile("[0-9A-Za-z._-]{8,200}\\.apps\\.googleusercontent\\.[a-z]{2,10}");
    private static final Pattern NONCE = Pattern.compile("[A-Za-z0-9_-]{16,128}");
    private static final Pattern JWT = Pattern.compile("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+");
    static final int MAX_ID_TOKEN_CHARS = 8192;

    private GoogleSignInPolicy() { }

    static boolean validClientId(String value) {
        return value != null && CLIENT_ID.matcher(value).matches();
    }

    static boolean validNonce(String value) {
        return value != null && NONCE.matcher(value).matches();
    }

    static boolean validIdToken(String value) {
        return value != null && value.length() <= MAX_ID_TOKEN_CHARS && JWT.matcher(value).matches();
    }

    /** Error code for a failed Credential Manager request. */
    static String errorCode(Throwable error) {
        if (error instanceof GetCredentialCancellationException) return CANCELLED;
        if (error instanceof NoCredentialException) return NO_CREDENTIAL;
        if (error instanceof GetCredentialProviderConfigurationException || error instanceof GetCredentialUnsupportedException) return UNAVAILABLE;
        return FAILED;
    }

    /** Short English message for the rejection (the web app shows its own Bahasa text per code). */
    static String message(String code) {
        if (CANCELLED.equals(code)) return "Google sign-in cancelled";
        if (NO_CREDENTIAL.equals(code)) return "No Google account available";
        if (UNAVAILABLE.equals(code)) return "Google sign-in unavailable on this device";
        if (INVALID.equals(code)) return "Invalid Google sign-in request";
        return "Google sign-in failed";
    }

    /** Routes that start a NEW session: the request goes out without the stored cookie. */
    static boolean signInPath(String path) {
        return "/api/auth/login".equals(path) || "/api/auth/register".equals(path) || SIGN_IN_PATH.equals(path);
    }

    /**
     * Whether a sign-in answer carries a session to store. Password login/register: any 2xx. Google: only 200; its
     * 202 is "registration pending" and has no account and no cookie.
     */
    static boolean opensSession(String path, int status) {
        if (!signInPath(path) || status < 200 || status >= 300) return false;
        return !SIGN_IN_PATH.equals(path) || status == 200;
    }
}
