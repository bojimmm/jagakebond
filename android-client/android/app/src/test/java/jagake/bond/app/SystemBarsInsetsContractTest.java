package jagake.bond.app;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

/** Source contract for the pinned Capacitor SystemBars insets configuration. */
public class SystemBarsInsetsContractTest {
    private static final Path ANDROID_CLIENT = Path.of("..", "..").toAbsolutePath().normalize();

    private String read(Path path) throws IOException {
        return new String(Files.readAllBytes(ANDROID_CLIENT.resolve(path)), java.nio.charset.StandardCharsets.UTF_8);
    }

    @Test
    public void viewportDoesNotRequestEdgeToEdgePassthroughOnModernWebView() throws IOException {
        String html = read(Path.of("..", "app", "frontend", "index.html"));
        assertFalse("viewport-fit=cover bypasses native safe padding on WebView >=140", html.contains("viewport-fit=cover"));
        assertTrue(html.contains("viewport-fit=contain"));
    }

    @Test
    public void nativeInsetsAreEnabledWhileSystemBarsRemainVisibleAndDarkStyled() throws IOException {
        String config = read(Path.of("capacitor.config.json"));

        assertTrue(config.contains("\"SystemBars\""));
        assertTrue(config.contains("\"insetsHandling\": \"native\""));
        assertTrue(config.contains("\"hidden\": false"));
        assertTrue(config.contains("\"style\": \"DARK\""));
    }

    @Test
    public void installedCapacitorImplementationAppliesCutoutAndSystemBarInsetsToWebViewBounds() throws IOException {
        String source = read(Path.of(
            "node_modules", "@capacitor", "android", "capacitor", "src", "main", "java",
            "com", "getcapacitor", "plugin", "SystemBars.java"
        ));

        assertTrue(source.contains("INSETS_HANDLING_NATIVE.equals(configuredInsetsHandling)"));
        assertTrue(source.contains("ViewCompat.setOnApplyWindowInsetsListener(view"));
        assertTrue(source.contains("WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()"));
        assertTrue(source.contains("v.setPadding("));
        assertTrue(source.contains("systemBarsInsets.top"));
        assertTrue(source.contains("windowInsetsControllerCompat.show(WindowInsetsCompat.Type.systemBars())"));
        assertTrue(source.contains("windowInsetsControllerCompat.setAppearanceLightStatusBars(!style.equals(STYLE_DARK))"));
    }
}
