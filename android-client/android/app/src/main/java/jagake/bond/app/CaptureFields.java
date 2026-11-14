package jagake.bond.app;

/** The capture parameters a draft carries and the upload sends, in wire order. Shared by the bridge, the store and the multipart builder. */
final class CaptureFields {
    static final String[] NAMES = {"lat", "lng", "elevation", "locationName", "accuracy", "weather", "photoDate", "photoTimestampMs",
            "farmId", "deviceId", "cropHint", "tier", "locationSource", "cropId", "cropName"};

    private CaptureFields() { }
}
