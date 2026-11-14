package jagake.bond.app;

import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialInterruptedException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnknownException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

/** 0.2.3.0 "Masuk dengan Google": Credential Manager result mapping and the bridge rules around it. */
public class GoogleSignInPolicyTest {
    @Test public void cancelAndNoCredentialMapToDistinctCodes() {
        assertEquals(GoogleSignInPolicy.CANCELLED, GoogleSignInPolicy.errorCode(new GetCredentialCancellationException("closed")));
        assertEquals(GoogleSignInPolicy.NO_CREDENTIAL, GoogleSignInPolicy.errorCode(new NoCredentialException("none")));
        assertNotEquals(GoogleSignInPolicy.CANCELLED, GoogleSignInPolicy.NO_CREDENTIAL);
    }

    @Test public void missingProviderIsUnavailableEverythingElseFailed() {
        assertEquals(GoogleSignInPolicy.UNAVAILABLE, GoogleSignInPolicy.errorCode(new GetCredentialProviderConfigurationException("no play services")));
        assertEquals(GoogleSignInPolicy.UNAVAILABLE, GoogleSignInPolicy.errorCode(new GetCredentialUnsupportedException("old")));
        assertEquals(GoogleSignInPolicy.FAILED, GoogleSignInPolicy.errorCode(new GetCredentialInterruptedException("again")));
        assertEquals(GoogleSignInPolicy.FAILED, GoogleSignInPolicy.errorCode(new GetCredentialUnknownException("?")));
        assertEquals(GoogleSignInPolicy.FAILED, GoogleSignInPolicy.errorCode(new IllegalStateException("parse")));
        assertEquals(GoogleSignInPolicy.FAILED, GoogleSignInPolicy.errorCode(null));
    }

    @Test public void everyCodeHasAMessage() {
        for (String code : new String[] { GoogleSignInPolicy.CANCELLED, GoogleSignInPolicy.NO_CREDENTIAL, GoogleSignInPolicy.UNAVAILABLE,
                GoogleSignInPolicy.FAILED, GoogleSignInPolicy.INVALID }) {
            assertFalse(code, GoogleSignInPolicy.message(code).isEmpty());
        }
        assertNotEquals(GoogleSignInPolicy.message(GoogleSignInPolicy.CANCELLED), GoogleSignInPolicy.message(GoogleSignInPolicy.NO_CREDENTIAL));
    }

    @Test public void validatesClientIdNonceAndToken() {
        assertTrue(GoogleSignInPolicy.validClientId("123456789012-abcdef0123456789.apps.googleusercontent.com"));
        assertFalse(GoogleSignInPolicy.validClientId(""));
        assertFalse(GoogleSignInPolicy.validClientId(null));
        assertFalse(GoogleSignInPolicy.validClientId("evil.example.com"));
        assertFalse(GoogleSignInPolicy.validClientId("x.apps.googleusercontent.com\n"));
        assertTrue(GoogleSignInPolicy.validNonce("AbC_-0123456789abcdefghijklmnop12"));
        assertFalse(GoogleSignInPolicy.validNonce("short"));
        assertFalse(GoogleSignInPolicy.validNonce("has space in it 0123456789"));
        assertFalse(GoogleSignInPolicy.validNonce(null));
        assertTrue(GoogleSignInPolicy.validIdToken("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"));
        assertFalse(GoogleSignInPolicy.validIdToken("not-a-token"));
        assertFalse(GoogleSignInPolicy.validIdToken(null));
        assertFalse(GoogleSignInPolicy.validIdToken("a.b.c.d"));
        assertFalse(GoogleSignInPolicy.validIdToken("a." + "b".repeat(GoogleSignInPolicy.MAX_ID_TOKEN_CHARS) + ".c"));
    }

    @Test public void onlyAGoogle200OpensASession() {
        assertTrue(GoogleSignInPolicy.opensSession("/api/auth/google", 200));
        assertFalse("202 = registration pending, no cookie", GoogleSignInPolicy.opensSession("/api/auth/google", 202));
        assertFalse(GoogleSignInPolicy.opensSession("/api/auth/google", 401));
        assertFalse(GoogleSignInPolicy.opensSession("/api/auth/google", 403));
        assertTrue(GoogleSignInPolicy.opensSession("/api/auth/login", 200));
        assertTrue(GoogleSignInPolicy.opensSession("/api/auth/register", 201));
        assertFalse(GoogleSignInPolicy.opensSession("/api/auth/login", 401));
        assertFalse(GoogleSignInPolicy.opensSession("/api/auth/google/nonce", 200));
        assertFalse(GoogleSignInPolicy.opensSession("/api/records", 200));
    }

    @Test public void signInRoutesGoOutWithoutTheStoredCookie() {
        assertTrue(GoogleSignInPolicy.signInPath("/api/auth/login"));
        assertTrue(GoogleSignInPolicy.signInPath("/api/auth/register"));
        assertTrue(GoogleSignInPolicy.signInPath("/api/auth/google"));
        assertFalse(GoogleSignInPolicy.signInPath("/api/auth/google/nonce"));
        assertFalse(GoogleSignInPolicy.signInPath("/api/auth/logout"));
    }

    @Test public void bridgeAllowsTheThreeGoogleRoutesWithTheirMethodsOnly() {
        assertTrue(JagaSyncPlugin.allowed("/api/auth/google/config", "GET"));
        assertTrue(JagaSyncPlugin.allowed("/api/auth/google/nonce", "POST"));
        assertTrue(JagaSyncPlugin.allowed("/api/auth/google", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/google", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/google/config", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/google/nonce", "GET"));
        assertFalse(JagaSyncPlugin.allowed("/api/auth/google/other", "POST"));
        assertFalse(JagaSyncPlugin.allowed("/api/admin/registrations", "GET"));
    }
}
