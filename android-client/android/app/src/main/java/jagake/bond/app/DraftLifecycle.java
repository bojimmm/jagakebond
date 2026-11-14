package jagake.bond.app;

import org.json.JSONObject;

/**
 * Keeps a draft and its archived photo together (audit M-1).
 *
 * <p>How photo ids relate to drafts: the web archives the full-quality original under {@code photoId = clientRequestId}
 * of the draft (unique per draft). The stamped copy of a finished analysis lives under {@code record_<jobId>} and is
 * independent of the draft. So when a draft is removed (discarded, or collected into a record) its own archive entry is
 * no longer needed and is deleted with its Keystore key; no other draft can share it. Photo cleanup is best effort and
 * never makes removing the draft fail.
 */
final class DraftLifecycle {
    private DraftLifecycle() { }

    /** @return true when the draft existed. */
    static boolean remove(OutboxStore store, PhotoArchive photos, String account, String clientRequestId) throws Exception {
        boolean existed = store.remove(account, clientRequestId);
        discardPhoto(photos, account, clientRequestId);
        return existed;
    }

    /** After a draft was replaced by an edited copy: drop the old original, but only once the new one is archived. */
    static void afterReplace(PhotoArchive photos, String account, String oldId, String newId) {
        if (photos.exists(account, newId)) discardPhoto(photos, account, oldId);
    }

    private static void discardPhoto(PhotoArchive photos, String account, String photoId) {
        try {
            photos.delete(account, photoId);
        } catch (Exception ignored) {
            // The orphaned encrypted photo is harmless; a later delete finishes the job.
        }
    }

    /** Capture fields are compared by value so a repeated enqueue is recognised whatever the JSON text order. */
    static boolean sameFields(JSONObject a, JSONObject b) {
        if (a == null || b == null) return false;
        for (String name : CaptureFields.NAMES) {
            boolean nullA = a.isNull(name);
            boolean nullB = b.isNull(name);
            if (nullA != nullB) return false;
            if (!nullA && !a.optString(name).equals(b.optString(name))) return false;
        }
        return true;
    }
}
