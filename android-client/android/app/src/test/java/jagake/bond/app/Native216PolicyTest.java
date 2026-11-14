package jagake.bond.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class Native216PolicyTest {
    @Test public void exportPermissionRejectsSwitchAwayAndBack() {
        assertTrue(JagaSyncPlugin.exportGenerationMatches(5L,5L));
        assertFalse(JagaSyncPlugin.exportGenerationMatches(5L,7L));
        assertFalse(JagaSyncPlugin.exportGenerationMatches(null,5L));
    }
    @Test public void uploadOnlyConsumesReadyOrRecoverableAttempt() {
        assertTrue(UploadPolicy.uploadStartAllowed("pending"));
        assertTrue(UploadPolicy.uploadStartAllowed("uploading"));
        assertTrue(UploadPolicy.uploadStartAllowed("blocked"));
        for (String s : new String[]{"editing", "cancelled", "rejected", "failed", "submitted", "unknown"}) assertFalse(s, UploadPolicy.uploadStartAllowed(s));
    }
    @Test public void editableStatusesExcludeUploadAndTerminalStates() {
        for (String s : new String[]{"pending", "blocked", "failed", "rejected", "cancelled", "editing"}) assertTrue(s, JagaSyncPlugin.editableStatus(s));
        for (String s : new String[]{"uploading", "submitted", "other"}) assertFalse(s, JagaSyncPlugin.editableStatus(s));
    }
    @Test public void coordinatesMustBePaired() {
        assertTrue(JagaSyncPlugin.pairedCoordinates(true, true));
        assertTrue(JagaSyncPlugin.pairedCoordinates(false, false));
        assertFalse(JagaSyncPlugin.pairedCoordinates(true, false));
        assertFalse(JagaSyncPlugin.pairedCoordinates(false, true));
    }
    @Test public void measuredCameraAccuracyIsNotRejectedAsManual() throws Exception {
        for (String source : new String[]{"gps", "camera-capture", "gallery-exif"}) {
            org.json.JSONObject value=new org.json.JSONObject();value.put("lat",-6.2);value.put("lng",106.8);value.put("accuracy",20);value.put("locationSource",source);
            JagaSyncPlugin.validateMetadata(value);
        }
        org.json.JSONObject manual=new org.json.JSONObject();manual.put("lat",0);manual.put("lng",0);manual.put("accuracy",20);manual.put("locationSource","manual");
        assertThrows(IllegalArgumentException.class,()->JagaSyncPlugin.validateMetadata(manual));
        manual.put("accuracy",org.json.JSONObject.NULL);JagaSyncPlugin.validateMetadata(manual);
    }
    @Test public void acceptsContractedProvenanceIdsOnly() {
        for (String s : new String[]{"gps", "manual", "plot", "unknown", "camera-capture", "gallery-exif", "gallery-unknown"}) assertTrue(s, JagaSyncPlugin.validLocationSource(s));
        assertFalse(JagaSyncPlugin.validLocationSource("made-up"));
    }
}
