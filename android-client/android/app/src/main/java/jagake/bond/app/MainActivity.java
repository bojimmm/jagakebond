package jagake.bond.app;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final OnBackPressedCallback backCallback = new OnBackPressedCallback(true) {
        @Override public void handleOnBackPressed() { onBack(); }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JagaSyncPlugin.class);
        super.onCreate(savedInstanceState);
        // Registered after the bridge is created so it is the first callback asked; it also works with the
        // predictive back gesture (android:enableOnBackInvokedCallback in the manifest) on Android 13+.
        getOnBackPressedDispatcher().addCallback(this, backCallback);
        NativeRecovery.start(getApplicationContext());
    }

    /** Back is handed to the web app as the document event {@link BackPolicy#EVENT}; the web decides what closes. */
    private void onBack() {
        Bridge bridge = getBridge();
        WebView webView = bridge == null ? null : bridge.getWebView();
        boolean pageLoaded = webView != null && webView.getProgress() >= 100;
        if (BackPolicy.onBackPressed(bridge != null, pageLoaded) == BackPolicy.Action.DISPATCH) {
            bridge.triggerDocumentJSEvent(BackPolicy.EVENT);
            return;
        }
        // Nothing can answer yet: behave like a normal Android app so the app can always be left.
        backCallback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        backCallback.setEnabled(true);
    }
}
