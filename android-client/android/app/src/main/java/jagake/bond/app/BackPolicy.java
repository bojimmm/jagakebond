package jagake.bond.app;

/**
 * What the Android back gesture/button does. Farmers were leaving the app by accident, so back no longer closes it:
 * it is handed to the web app as a document event and the web decides (close a sheet, go home, or ask to exit and then
 * call {@code JagaSync.exitApp()}). Only while the page is not up yet, where nothing could answer, back keeps its
 * normal Android meaning so the app can never become impossible to leave.
 */
final class BackPolicy {
    /** Document event the web app listens for: {@code document.addEventListener('jagaBack', ...)}. */
    static final String EVENT = "jagaBack";

    enum Action { DISPATCH, EXIT }

    private BackPolicy() { }

    static Action onBackPressed(boolean bridgeReady, boolean pageLoaded) {
        return bridgeReady && pageLoaded ? Action.DISPATCH : Action.EXIT;
    }
}
