package jagake.bond.app;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Iterator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Source-level contracts of the 0.2.2.0 release: identity, signing, debuggability, back handling, least-privilege
 * files. They run from the module directory (android/app), like the other source contract tests.
 */
public class ReleaseContractTest {
    private static String read(String relative) throws Exception {
        return new String(Files.readAllBytes(Paths.get(relative)), StandardCharsets.UTF_8);
    }

    private static final String CLIENT = "../../";

    @Test public void versionIsConsistentEverywhere() throws Exception {
        String gradle = read("build.gradle");
        assertTrue(gradle, gradle.contains("versionCode 56"));
        assertTrue(gradle, gradle.contains("versionName \"0.2.4.28\""));
        assertEquals("0.2.4.28", NativeHttp.APP_VERSION);
        assertEquals("X-JK-App-Version", NativeHttp.VERSION_HEADER);
    }

    @Test public void releaseBuildIsSignedWithTheExistingDebugKeystoreButIsNotDebuggable() throws Exception {
        String gradle = read("build.gradle");
        String release = gradle.substring(gradle.indexOf("release {"));
        assertTrue(release.contains("debuggable false"));
        assertTrue(release.contains("minifyEnabled false"));
        assertTrue(release.contains("signingConfig signingConfigs.shared"));
        assertTrue(gradle.contains("androiddebugkey"));
        assertTrue("same keystore file as the debug build", gradle.contains(".android") && gradle.contains("debug.keystore"));
        assertFalse("the signing key must never be created or replaced by the build", gradle.contains("keytool") || gradle.contains("genkey"));
    }

    @Test public void webDebuggingAndLoggingAreOffForReleaseAndOnlyOnForDebug() throws Exception {
        JSONObject base = new JSONObject(read(CLIENT + "capacitor.config.json"));
        JSONObject release = new JSONObject(read("src/release/assets/capacitor.config.json"));
        JSONObject debug = new JSONObject(read("src/debug/assets/capacitor.config.json"));
        assertFalse(base.getJSONObject("android").getBoolean("webContentsDebuggingEnabled"));
        assertEquals("none", base.getString("loggingBehavior"));
        assertEquals(base.toString(), release.toString());
        assertTrue(debug.getJSONObject("android").getBoolean("webContentsDebuggingEnabled"));
        assertEquals("debug", debug.getString("loggingBehavior"));
        // Apart from those two switches, all three configurations are identical.
        JSONObject a = new JSONObject(base.toString());
        JSONObject b = new JSONObject(debug.toString());
        a.getJSONObject("android").remove("webContentsDebuggingEnabled");
        b.getJSONObject("android").remove("webContentsDebuggingEnabled");
        a.remove("loggingBehavior");
        b.remove("loggingBehavior");
        assertEquals(sorted(a), sorted(b));
    }

    private static String sorted(JSONObject object) throws Exception {
        java.util.TreeMap<String, String> map = new java.util.TreeMap<>();
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            String key = keys.next();
            Object value = object.get(key);
            map.put(key, value instanceof JSONObject ? sorted((JSONObject) value) : String.valueOf(value));
        }
        return map.toString();
    }

    @Test public void nativeUserAgentStaysAndCordovaHasNoWildcardAccess() throws Exception {
        JSONObject base = new JSONObject(read(CLIENT + "capacitor.config.json"));
        assertEquals("JagaKebond/2.1 (+https://jagake.bond)", base.getJSONObject("android").getString("appendUserAgent"));
        String origin = base.getJSONObject("cordova").getJSONArray("accessOrigins").getString(0);
        assertEquals("https://jagake.bond", origin);
        Path generated = Paths.get("src/main/res/xml/config.xml");
        if (Files.exists(generated)) {
            assertFalse("cap sync writes this from cordova.accessOrigins", read("src/main/res/xml/config.xml").contains("origin=\"*\""));
        }
    }

    @Test public void fileProviderOnlyExposesTheCameraPictureFolder() throws Exception {
        String paths = read("src/main/res/xml/file_paths.xml");
        assertTrue(paths.contains("<external-files-path"));
        assertTrue(paths.contains("path=\"Pictures/\""));
        assertFalse("not the whole external storage", paths.contains("<external-path"));
        assertFalse(paths.contains("<cache-path"));
        assertFalse(paths.contains("path=\".\""));
    }

    @Test public void backGestureIsHandedToTheWebAppAndPredictiveBackIsEnabled() throws Exception {
        String manifest = read("src/main/AndroidManifest.xml");
        assertTrue(manifest.contains("android:enableOnBackInvokedCallback=\"true\""));
        assertFalse("release must not be debuggable", manifest.contains("android:debuggable=\"true\""));
        assertTrue(manifest.contains("android:allowBackup=\"false\""));
        String activity = read("src/main/java/jagake/bond/app/MainActivity.java");
        assertTrue(activity.contains("OnBackPressedCallback"));
        assertTrue(activity.contains("getOnBackPressedDispatcher().addCallback(this, backCallback)"));
        assertTrue(activity.contains("triggerDocumentJSEvent(BackPolicy.EVENT)"));
        assertEquals("jagaBack", BackPolicy.EVENT);
        String plugin = read("src/main/java/jagake/bond/app/JagaSyncPlugin.java");
        assertTrue(plugin.contains("public void exitApp(PluginCall call)"));
        assertTrue(plugin.contains("public void photoDelete(PluginCall call)"));
        assertTrue(plugin.contains("public void quarantineAck(PluginCall call)"));
    }

    @Test public void backPolicyDispatchesOnlyWhenTheWebAppCanAnswer() {
        assertEquals(BackPolicy.Action.DISPATCH, BackPolicy.onBackPressed(true, true));
        assertEquals("page still loading: nothing could answer, so keep the normal Android back", BackPolicy.Action.EXIT, BackPolicy.onBackPressed(true, false));
        assertEquals(BackPolicy.Action.EXIT, BackPolicy.onBackPressed(false, false));
        assertEquals(BackPolicy.Action.EXIT, BackPolicy.onBackPressed(false, true));
    }

    @Test public void uploadsAreStreamedWithAFixedLengthAndBoundedTimeouts() throws Exception {
        String transport = read("src/main/java/jagake/bond/app/HttpTransport.java");
        assertTrue(transport.contains("setFixedLengthStreamingMode("));
        String plugin = read("src/main/java/jagake/bond/app/JagaSyncPlugin.java");
        assertTrue(plugin.contains("setFixedLengthStreamingMode("));
        assertEquals(20_000, NativeHttp.JSON_TIMEOUT_MS);
        assertEquals(90_000, NativeHttp.UPLOAD_READ_TIMEOUT_MS);
        assertEquals(10_000, NativeHttp.HEALTH_TIMEOUT_MS);
        assertEquals(2 * 1024 * 1024, NativeHttp.MAX_JSON_BYTES);
        assertEquals("bridge health checks use the short timeout", 10_000, NativeHttp.timeoutFor("/api/health"));
        assertEquals(20_000, NativeHttp.timeoutFor("/api/records"));
        assertTrue(NativeHttp.deadlineFor("/api/health") < NativeHttp.deadlineFor("/api/records"));
        assertTrue(plugin.contains("NativeHttp.timeoutFor(barePath)"));
    }

    @Test public void syncAssetsFailsLoudlyWhenAFileIsMissing() throws Exception {
        String script = read(CLIENT + "scripts/sync-assets.mjs");
        assertTrue(script.contains("process.exit(1)"));
        assertTrue(script.contains("native-adapter.js"));
        assertTrue(script.contains("offline-sync.js"));
    }
}
