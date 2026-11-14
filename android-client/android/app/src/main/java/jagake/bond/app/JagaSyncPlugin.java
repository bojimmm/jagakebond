package jagake.bond.app;

import android.os.Build;
import android.os.CancellationSignal;
import android.content.ContentValues;
import android.provider.MediaStore;
import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;
import androidx.exifinterface.media.ExifInterface;
import java.io.OutputStream;

import androidx.work.ExistingWorkPolicy;

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "JagaSync", permissions = { @Permission(alias = "mediaWrite", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) })
public class JagaSyncPlugin extends Plugin {
    private static final Pattern ACCOUNT = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern PHOTO_PATH = Pattern.compile("/api/photos/[A-Za-z0-9_-]{1,128}");
    private static final Pattern PHOTO_THUMBNAIL_PATH = Pattern.compile("/api/photos/[A-Za-z0-9_-]{1,128}/thumbnail");
    private static final int MAX_PHOTO_THUMBNAIL_BYTES = 16 * 1024;
    static final String[] FIELDS = CaptureFields.NAMES;
    static final int MAX_PHOTO_BYTES = NativeHttp.MAX_PHOTO_BYTES;
    private final java.util.concurrent.ConcurrentHashMap<String,Long> exportPermissions = new java.util.concurrent.ConcurrentHashMap<>();

    @PluginMethod
    public void request(PluginCall call) {
        String path = call.getString("path", "");
        String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        if (!allowed(path, method)) { call.reject("Request route is not allowed"); return; }
        boolean logout = path.equals("/api/auth/logout");
        String loggedInAccount = null;
        try {
            JSONObject body = call.getObject("body", new JSObject());
            if (!method.equals("GET") && !method.equals("DELETE") && body == null) throw new IllegalArgumentException("JSON body required");
            String account = NativeStore.activeAccount(getContext());
            JSONObject session = account == null ? null : NativeStore.session(getContext(), account);
            long generation = NativeStore.generation(getContext());
            if (GoogleSignInPolicy.signInPath(path)) session = null;
            if (logout) NativeStore.lock(getContext());
            JSObject result;
            try {
                result = perform(path, method, body, session);
            } catch (Exception failed) {
                // Offline logout: the local session is already locked; keep the old server session's token to revoke it later.
                if (logout) queueRevoke(account, session);
                throw failed;
            }
            if (logout && RevokeQueue.shouldRetry(result.getInt("status"))) queueRevoke(account, session);
            synchronized (NativeStore.LOCK) {
                boolean sameOwner = session == null || (account != null && account.equals(NativeStore.activeAccount(getContext())) && generation == NativeStore.generation(getContext()));
                if (!sameOwner && !GoogleSignInPolicy.signInPath(path) && !path.equals("/api/auth/logout")) {
                    result.put("status", 401); result.put("body", new JSONObject().put("detail", "Session changed")); result.remove("encoding");
                } else if (GoogleSignInPolicy.opensSession(path, result.getInt("status"))) {
                    Object responseBody = result.opt("body");
                    JSONObject response = responseBody instanceof JSONObject ? (JSONObject) responseBody : new JSONObject(String.valueOf(responseBody));
                    JSONObject profile = response.optJSONObject("account");
                    String accountId = profile == null ? null : profile.optString("id", null);
                    JSONObject saved = validAccount(accountId) ? cookieSession(result.optString("_setCookie", ""), response.optString("csrf", "")) : null;
                    if (saved != null) { NativeStore.saveSession(getContext(), accountId, saved); NativeStore.setActive(getContext(), accountId); loggedInAccount = accountId; }
                    else { result.put("status", 502); result.put("body", new JSONObject().put("detail", "Session cookie missing or invalid")); }
                } else if (session != null && result.has("_setCookie") && account != null) {
                    JSONObject refreshed = cookieSession(result.optString("_setCookie", ""), session.optString("csrf", ""));
                    if (refreshed != null) NativeStore.saveSession(getContext(), account, refreshed);
                }
            }
            result.remove("_setCookie");
            call.resolve(result);
            if (loggedInAccount != null) UploadScheduler.afterLogin(getContext(), loggedInAccount);
        } catch (Exception e) {
            if ("/api/auth/logout".equals(call.getString("path", ""))) NativeStore.lock(getContext());
            call.reject("Native request failed safely", e);
        }
    }

    /**
     * "Masuk dengan Google" (0.2.3.0): asks Credential Manager for a Google ID token carrying the server's nonce and
     * returns {@code {idToken}}. The web app posts it to /api/auth/google through {@link #request}; nothing is sent
     * from here. Google blocks its web sign-in inside a WebView, hence this native path. Failures reject with the codes
     * in {@link GoogleSignInPolicy} (cancel and no-account are told apart).
     */
    @PluginMethod
    public void googleSignIn(final PluginCall call) {
        String clientId = call.getString("serverClientId", "");
        String nonce = call.getString("nonce", "");
        if (!GoogleSignInPolicy.validClientId(clientId) || !GoogleSignInPolicy.validNonce(nonce)) {
            call.reject(GoogleSignInPolicy.message(GoogleSignInPolicy.INVALID), GoogleSignInPolicy.INVALID); return;
        }
        final android.app.Activity activity = getActivity();
        if (activity == null) { call.reject(GoogleSignInPolicy.message(GoogleSignInPolicy.FAILED), GoogleSignInPolicy.FAILED); return; }
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(clientId).setNonce(nonce).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager.create(activity).getCredentialAsync(activity, request, new CancellationSignal(),
                ContextCompat.getMainExecutor(activity), new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override public void onResult(GetCredentialResponse response) {
                        String token = null;
                        Credential credential = response.getCredential();
                        if (credential instanceof CustomCredential
                                && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                            try { token = GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken(); }
                            catch (Exception parsing) { token = null; }
                        }
                        if (!GoogleSignInPolicy.validIdToken(token)) {
                            call.reject(GoogleSignInPolicy.message(GoogleSignInPolicy.FAILED), GoogleSignInPolicy.FAILED); return;
                        }
                        JSObject out = new JSObject(); out.put("idToken", token); call.resolve(out);
                    }

                    @Override public void onError(GetCredentialException error) {
                        String code = GoogleSignInPolicy.errorCode(error);
                        call.reject(GoogleSignInPolicy.message(code), code);
                    }
                });
    }

    /** Keeps the session token of a logout the server never heard about, encrypted, and revokes it when online. */
    private void queueRevoke(String account, JSONObject session) {
        if (account == null || session == null || session.optString("cookie", "").isEmpty()) return;
        try {
            String id = NativeStore.revokes(getContext()).add(account, session.optString("cookie"), session.optString("csrf", ""),
                    session.optLong("expiresAtMs", 0));
            RevokeWorker.enqueue(getContext(), account, id, ExistingWorkPolicy.KEEP);
        } catch (Exception ignored) {
            // Best effort: the local session is locked either way and the server session expires on its own.
        }
    }

    @PluginMethod
    public void activate(PluginCall call) {
        String accountId = call.getString("accountId", "");
        if (!validAccount(accountId)) { call.reject("Invalid account"); return; }
        try {
            long generation = NativeStore.generation(getContext());
            JSONObject session = NativeStore.session(getContext(), accountId);
            if (session == null || session.optString("cookie", "").isEmpty()) { call.reject("Authentication required"); return; }
            if (accountId.equals(NativeStore.activeAccount(getContext()))) {
                if (session.optLong("expiresAtMs", 0) <= System.currentTimeMillis()) { call.reject("Session expired; sign in online"); return; }
                resumeUploads(accountId);
                JSObject same = new JSObject(); same.put("ok", true); same.put("accountId", accountId); call.resolve(same); return;
            }
            JSObject me = perform("/api/auth/me", "GET", new JSONObject(), session);
            if (me.getInt("status") != 200) { call.reject("Online account verification required"); return; }
            Object body = me.get("body");
            JSONObject payload = body instanceof JSONObject ? (JSONObject) body : new JSONObject(String.valueOf(body));
            JSONObject profile = payload.optJSONObject("account");
            if (!payload.optBoolean("ok") || profile == null || !accountId.equals(profile.optString("id"))) {
                call.reject("Saved session does not match requested account"); return;
            }
            if (!payload.optString("csrf", "").isEmpty()) session.put("csrf", payload.optString("csrf"));
            synchronized (NativeStore.LOCK) {
                if (generation != NativeStore.generation(getContext())) { call.reject("Session changed during verification"); return; }
                NativeStore.saveSession(getContext(), accountId, session);
                NativeStore.setActive(getContext(), accountId);
            }
            resumeUploads(accountId);
            JSObject result = new JSObject(); result.put("ok", true); result.put("accountId", accountId); call.resolve(result);
        } catch (Exception e) { call.reject("Account verification failed", e); }
    }

    /** Recover stuck rows and queue what may be tried now. A broken outbox must not block signing in: list() reports it. */
    private void resumeUploads(String accountId) {
        try { UploadScheduler.recoverAndSchedule(getContext(), accountId); } catch (Exception ignored) { /* retried on the next activate */ }
        UploadScheduler.scheduleRevokes(getContext(), accountId);
    }

    @PluginMethod
    public void lock(PluginCall call) {
        NativeStore.lock(getContext()); JSObject out = new JSObject(); out.put("ok", true); call.resolve(out);
    }

    /** Leave the app on request of the web app (after it handled the {@code jagaBack} event and the farmer confirmed). */
    @PluginMethod public void exitApp(PluginCall call) {
        final android.app.Activity activity = getActivity();
        if (activity == null) { call.reject("Activity unavailable"); return; }
        final boolean background = Boolean.TRUE.equals(call.getBoolean("background", false));
        JSObject out = new JSObject(); out.put("ok", true); call.resolve(out);
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (background) activity.moveTaskToBack(true);
                else activity.finish();
            }
        });
    }

    /** Store an independently AES-GCM-encrypted, account-scoped JPEG and JSON metadata. */
    @PluginMethod public void photoPut(PluginCall call) {
        String account = call.getString("accountId", ""), photoId = call.getString("photoId", "");
        String image = call.getString("imageBase64", ""); JSONObject metadata = call.getObject("metadata", new JSObject());
        if (!validAccount(account) || !validId(photoId) || image.isEmpty() || metadata == null) { call.reject("Invalid photo archive request"); return; }
        if (!owner(account)) { call.reject("Activate the matching account first"); return; }
        try {
            byte[] bytes = B64.decode(image);
            image = null;
            if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES || (bytes[0]&255)!=255 || (bytes[1]&255)!=216) throw new IllegalArgumentException("Photo must be JPEG <=12 MiB");
            validateJpeg(bytes);
            validateMetadata(metadata);
            synchronized (NativeStore.LOCK) {
                if (!owner(account)) throw new SecurityException("Active account changed");
                NativeStore.photos(getContext()).put(account, photoId, bytes, metadata);
            }
            JSObject out = new JSObject(); out.put("ok", true); call.resolve(out);
        } catch (Exception e) { call.reject("Could not save encrypted photo", e); }
    }

    /** Return this account's archived JPEG only while the captured account generation remains current. */
    @PluginMethod public void photoGet(PluginCall call) {
        String account = call.getString("accountId", ""), photoId = call.getString("photoId", "");
        if (!validAccount(account) || !validId(photoId)) { call.reject("Invalid photo archive request"); return; }
        long generation = NativeStore.generation(getContext());
        try {
            PhotoArchive.Photo archived = NativeStore.photos(getContext()).get(account, photoId);
            synchronized (NativeStore.LOCK) {
                if (generation != NativeStore.generation(getContext()) || !account.equals(NativeStore.activeAccount(getContext()))) { call.reject("Active account changed"); return; }
                JSObject out = new JSObject();
                if (archived == null) out.put("found", false);
                else { out.put("imageBase64", B64.encode(archived.jpeg)); out.put("metadata", archived.metadata); }
                call.resolve(out);
            }
        } catch (Exception e) { call.reject("Could not read encrypted photo", e); }
    }

    /**
     * Delete one archived photo (the encrypted file and its Keystore key) of the active account.
     * Idempotent: a photo that is not there answers {@code {deleted:false}}. {@code accountId} is optional but, when given,
     * must be the active account.
     */
    @PluginMethod public void photoDelete(PluginCall call) {
        String photoId = call.getString("photoId", "");
        String requested = call.getString("accountId", "");
        String account = NativeStore.activeAccount(getContext());
        if (!validId(photoId) || !validAccount(account) || (requested != null && !requested.isEmpty() && !requested.equals(account))) {
            call.reject("Invalid photo delete request"); return;
        }
        try {
            boolean deleted;
            synchronized (NativeStore.LOCK) {
                if (!account.equals(NativeStore.activeAccount(getContext()))) throw new SecurityException("Active account changed");
                deleted = NativeStore.photos(getContext()).delete(account, photoId);
            }
            JSObject out = new JSObject(); out.put("deleted", deleted); call.resolve(out);
        } catch (Exception e) { call.reject("Could not delete encrypted photo", e); }
    }

    /** Explicit user action: export JPEG to the public Pictures/JagaKebond collection. */
    @PluginMethod public void photoExport(PluginCall call) {
        String account = call.getString("accountId", ""), photoId = call.getString("photoId", "");
        final long generation;
        synchronized (NativeStore.LOCK) {
            if (!owner(account) || !validId(photoId)) { call.reject("Invalid photo export request"); return; }
            generation = NativeStore.generation(getContext());
        }
        if (Build.VERSION.SDK_INT <= 28 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            exportPermissions.put(call.getCallbackId(), generation);
            requestPermissionForAlias("mediaWrite", call, "mediaWritePermissionResult"); return;
        }
        exportPhoto(call, account, photoId, generation);
    }

    @PermissionCallback private void mediaWritePermissionResult(PluginCall call) {
        String account = call.getString("accountId", ""), photoId = call.getString("photoId", "");
        Long generation = exportPermissions.remove(call.getCallbackId());
        if (!owner(account) || !validId(photoId) || !exportGenerationMatches(generation, NativeStore.generation(getContext()))) { call.reject("Active account changed or invalid export request"); return; }
        if (getPermissionState("mediaWrite") != com.getcapacitor.PermissionState.GRANTED) { call.reject("Gallery export denied: storage permission required"); return; }
        exportPhoto(call, account, photoId, generation);
    }

    private void exportPhoto(PluginCall call, String account, String photoId, long generation) {
        android.net.Uri uri = null;
        try {
            if (!ownerGeneration(account, generation)) throw new SecurityException("Active account changed");
            PhotoArchive.Photo saved = NativeStore.photos(getContext()).get(account, photoId);
            String rendered=call.getString("imageBase64", "");
            if (saved == null && rendered.isEmpty()) { call.reject("Archived photo not found"); return; }
            byte[] jpeg = rendered.isEmpty()?saved.jpeg:PhotoExportImage.decode(rendered,MAX_PHOTO_BYTES);
            JSONObject metadata = rendered.isEmpty()?saved.metadata:call.getObject("metadata",new JSObject());
            validateJpeg(jpeg);validateMetadata(metadata);
            ContentValues values = new ContentValues(); values.put(MediaStore.Images.Media.DISPLAY_NAME, "JagaKebond-" + photoId + ".jpg");
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            if (Build.VERSION.SDK_INT >= 29) { values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/JagaKebond"); values.put(MediaStore.Images.Media.IS_PENDING, 1); }
            uri = getContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new java.io.IOException("MediaStore did not create an export item");
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "w")) { if (stream == null) throw new java.io.IOException("Could not open export output"); stream.write(jpeg); }
            validateJpeg(jpeg);
            if (metadata.has("lat") && metadata.has("lng") && !metadata.isNull("lat") && !metadata.isNull("lng")) {
                double lat = metadata.getDouble("lat"), lng = metadata.getDouble("lng");
                if (!Double.isFinite(lat) || !Double.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new IllegalArgumentException("Invalid GPS coordinates");
                try (android.os.ParcelFileDescriptor fd = getContext().getContentResolver().openFileDescriptor(uri, "rw")) {
                    if (fd == null) throw new java.io.IOException("Could not open EXIF output");
                    ExifInterface exif = new ExifInterface(fd.getFileDescriptor()); exif.setLatLong(lat, lng);
                    String source = metadata.optString("locationSource", "");
                    if ("manual".equals(source) || "plot".equals(source)) exif.setAttribute(ExifInterface.TAG_USER_COMMENT, "locationSource=" + source);
                    exif.saveAttributes();
                }
            } else {
                String source = metadata.optString("locationSource", "");
                if ("manual".equals(source) || "plot".equals(source)) {
                    try (android.os.ParcelFileDescriptor fd = getContext().getContentResolver().openFileDescriptor(uri, "rw")) {
                        if (fd == null) throw new java.io.IOException("Could not open EXIF output");
                        ExifInterface exif = new ExifInterface(fd.getFileDescriptor()); exif.setAttribute(ExifInterface.TAG_USER_COMMENT, "locationSource=" + source); exif.saveAttributes();
                    }
                }
            }
            synchronized (NativeStore.LOCK) {
                if (!ownerGeneration(account, generation)) throw new SecurityException("Active account changed before export publish");
                if (Build.VERSION.SDK_INT >= 29) { ContentValues publish = new ContentValues(); publish.put(MediaStore.Images.Media.IS_PENDING, 0); if(getContext().getContentResolver().update(uri, publish, null, null)!=1) throw new java.io.IOException("Could not publish completed gallery item"); }
                JSObject out = new JSObject(); out.put("ok", true); out.put("uri", uri.toString()); call.resolve(out);
            }
        } catch (Exception e) { if (uri != null) try { getContext().getContentResolver().delete(uri, null, null); } catch (Exception ignored) {} call.reject("Gallery export failed", e); }
    }

    /** Read one draft with its payload; list() deliberately remains metadata-only. */
    @PluginMethod public void draftGet(PluginCall call) {
        String account=call.getString("accountId", ""), id=call.getString("clientRequestId", "");
        if (!owner(account) || !validId(id)) { call.reject("Activate matching account and provide valid draft id"); return; }
        long generation=NativeStore.generation(getContext());
        try {
            OutboxStore.Draft draft = NativeStore.outbox(getContext()).readDraft(account, id);
            synchronized(NativeStore.LOCK){
                if(!ownerGeneration(account,generation)){call.reject("Active account changed");return;}
                if(draft==null){call.reject("Draft not found");return;}
                JSObject out=new JSObject(); out.put("draft", draftJson(account, draft)); call.resolve(out);
            }
        } catch (OutboxStore.PayloadException e) { call.reject(e.missing ? "Draft photo is missing" : "Draft photo is unreadable", e); }
        catch(Exception e){ call.reject("Could not read draft", e); }
    }

    private static JSONObject draftJson(String account, OutboxStore.Draft draft) throws Exception {
        JSONObject row = draft.meta;
        JSONObject item = new JSONObject();
        item.put("accountId", account); item.put("clientRequestId", row.optString("clientRequestId"));
        item.put("fields", row.optJSONObject("fields")); item.put("createdMs", row.optLong("createdMs"));
        item.put("status", row.optString("status", "pending"));
        item.put("imageBase64", draft.image != null ? B64.encode(draft.image) : draft.rawBase64);
        copyOptional(row, item);
        return item;
    }

    private static void copyOptional(JSONObject row, JSONObject item) throws Exception {
        if (row.has("jobId")) item.put("jobId", row.get("jobId"));
        if (row.has("error")) item.put("error", row.get("error"));
        if (row.has("nextAttemptAtMs")) item.put("nextAttemptAtMs", row.get("nextAttemptAtMs"));
        if (row.has("serverCode")) item.put("serverCode", row.get("serverCode"));
    }

    /** Atomically move editable draft bytes to a fresh id, held in editing state until draftResume. */
    @PluginMethod public void draftEdit(PluginCall call) {
        String account=call.getString("accountId", ""), oldId=call.getString("clientRequestId", ""), newId=call.getString("newClientRequestId", ""); JSObject fields=call.getObject("fields");
        if (!owner(account) || !validId(oldId) || !validId(newId) || oldId.equals(newId) || fields==null) { call.reject("Invalid draft edit"); return; }
        try { synchronized(NativeStore.LOCK){
            if(!owner(account)){call.reject("Active account changed");return;}
            OutboxStore store = NativeStore.outbox(getContext());
            JSONObject old = store.meta(account, oldId);
            String status=old==null?"":old.optString("status"); if(old==null || !editableStatus(status)){call.reject("Draft is not editable");return;}
            if(store.meta(account, newId)!=null){call.reject("New draft id already exists");return;}
            JSONObject cleanFields=new JSONObject(); for(String name:FIELDS){ Object value=fields.has(name)&&!fields.isNull(name)?fields.get(name):JSONObject.NULL; if(value!=JSONObject.NULL&&!(value instanceof String))throw new IllegalArgumentException("Capture fields must be strings or null"); cleanFields.put(name,value); }
            validateMetadata(cleanFields);
            UploadScheduler.cancel(getContext(), account, oldId);
            store.replace(account, oldId, newId, cleanFields, "editing");
            DraftLifecycle.afterReplace(NativeStore.photos(getContext()), account, oldId, newId);
            JSObject out=new JSObject();out.put("ok",true);out.put("clientRequestId",newId);call.resolve(out);
        }} catch(Exception e){call.reject("Could not edit encrypted draft",e);}
    }

    /** Explicitly resume a draft in editing state and retain the stable WorkManager schedule. */
    @PluginMethod public void draftResume(PluginCall call) {
        String account=call.getString("accountId", ""), id=call.getString("clientRequestId", ""); if(!owner(account)||!validId(id)){call.reject("Invalid draft resume");return;}
        try{synchronized(NativeStore.LOCK){
            if(!owner(account)){call.reject("Active account changed");return;}
            OutboxStore store = NativeStore.outbox(getContext());
            JSONObject row=store.meta(account,id); if(row==null||!"editing".equals(row.optString("status"))){call.reject("Draft is not awaiting resume");return;}
            store.update(account,id,new OutboxStore.RowEdit(){ @Override public boolean apply(JSONObject r) throws Exception { r.put("status","pending"); return true; } });
            UploadScheduler.enqueue(getContext(), account, id, 0, ExistingWorkPolicy.KEEP);
            JSObject out=new JSObject();out.put("ok",true);call.resolve(out);}}
        catch(Exception e){call.reject("Could not resume draft",e);}
    }

    /** Persist only an already-submitted job's terminal server state; never forge a receipt. */
    @PluginMethod public void draftMark(PluginCall call) {
        final String account=call.getString("accountId", ""),id=call.getString("clientRequestId", ""),status=call.getString("status", "");
        if(!owner(account)||!validId(id)||!("failed".equals(status)||"cancelled".equals(status)||"rejected".equals(status))){call.reject("Invalid terminal draft update");return;}
        final String error=call.getString("error", "");
        try{synchronized(NativeStore.LOCK){
            if(!owner(account)){call.reject("Active account changed");return;}
            OutboxStore store = NativeStore.outbox(getContext());
            JSONObject row=store.meta(account,id); if(row==null||!"submitted".equals(row.optString("status"))){call.reject("Only submitted drafts can be marked terminal");return;}
            String job=call.getString("jobId", ""); if(job.isEmpty()||!job.equals(row.optString("jobId", ""))){call.reject("Submitted job id mismatch");return;}
            store.update(account,id,new OutboxStore.RowEdit(){ @Override public boolean apply(JSONObject r) throws Exception { r.put("status",status); r.put("error",error); return true; } });
            JSObject out=new JSObject();out.put("ok",true);call.resolve(out);}}
        catch(Exception e){call.reject("Could not persist terminal draft state",e);}
    }

    private boolean owner(String account){return validAccount(account)&&account.equals(NativeStore.activeAccount(getContext()));}
    private boolean ownerGeneration(String account,long generation){return owner(account)&&generation==NativeStore.generation(getContext());}
    static boolean exportGenerationMatches(Long expected,long actual){return expected!=null&&expected==actual;}
    static boolean editableStatus(String status){return "pending".equals(status)||"blocked".equals(status)||"failed".equals(status)||"rejected".equals(status)||"cancelled".equals(status)||"editing".equals(status);}
    static boolean pairedCoordinates(boolean lat,boolean lng){return lat==lng;}
    static boolean validLocationSource(String source){return "gps".equals(source)||"manual".equals(source)||"plot".equals(source)||"unknown".equals(source)||"camera-capture".equals(source)||"gallery-exif".equals(source)||"gallery-unknown".equals(source);}
    private static void validateJpeg(byte[] bytes)throws java.io.IOException{ android.graphics.BitmapFactory.Options o=new android.graphics.BitmapFactory.Options(); o.inJustDecodeBounds=true; android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.length,o); if(o.outWidth<=0||o.outHeight<=0||o.outWidth>12000||o.outHeight>12000||(long)o.outWidth*o.outHeight>100_000_000L)throw new java.io.IOException("Invalid JPEG dimensions"); }
    static boolean validId(String id){return id!=null&&ID.matcher(id).matches();}
    static void validateMetadata(JSONObject metadata)throws Exception{
        if(!pairedCoordinates(metadata.has("lat")&&!metadata.isNull("lat"),metadata.has("lng")&&!metadata.isNull("lng")))throw new IllegalArgumentException("Latitude and longitude must be paired");
        if(metadata.has("lat")&&metadata.isNull("lat")!=metadata.isNull("lng"))throw new IllegalArgumentException("Latitude and longitude must be paired");
        if(metadata.has("lat")&&!metadata.isNull("lat")){double lat=metadata.getDouble("lat"),lng=metadata.getDouble("lng");if(!Double.isFinite(lat)||!Double.isFinite(lng)||lat < -90||lat>90||lng < -180||lng>180)throw new IllegalArgumentException("Coordinates must be WGS84");}
        String source=metadata.optString("locationSource", "unknown");if(source.isEmpty()||"null".equals(source))source="unknown";if(!validLocationSource(source))throw new IllegalArgumentException("Invalid location provenance");
        if(("manual".equals(source)||"plot".equals(source)||"unknown".equals(source)||"gallery-unknown".equals(source))&&metadata.has("accuracy")&&!metadata.isNull("accuracy"))throw new IllegalArgumentException("Manual/plot location cannot claim GPS accuracy");
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        String accountId = call.getString("accountId", "");
        String requestId = call.getString("clientRequestId", "");
        String image = call.getString("imageBase64", "");
        JSObject fields = call.getObject("fields");
        if (!validAccount(accountId) || !ID.matcher(requestId).matches() || image.isEmpty() || fields == null) {
            call.reject("Invalid upload draft"); return;
        }
        if (!accountId.equals(NativeStore.activeAccount(getContext()))) { call.reject("Activate the matching account first"); return; }
        try {
            JSONObject session = NativeStore.session(getContext(), accountId);
            if (session == null || session.optLong("expiresAtMs", 0) <= System.currentTimeMillis()) { call.reject("Sign in again before saving an upload"); return; }
            byte[] bytes = B64.decode(image);
            image = null;
            if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES || (bytes[0] & 255) != 255 || (bytes[1] & 255) != 216) {
                call.reject("Image must be a JPEG between 4 bytes and 12 MiB"); return;
            }
            synchronized (NativeStore.LOCK) {
            if (!accountId.equals(NativeStore.activeAccount(getContext()))) { call.reject("Activate the matching account first"); return; }
            OutboxStore store = NativeStore.outbox(getContext());
            JSONObject clean = new JSONObject();
            for (String name : FIELDS) {
                Object value = fields.has(name) && !fields.isNull(name) ? fields.get(name) : JSONObject.NULL;
                if (value != JSONObject.NULL && !(value instanceof String)) { call.reject("Capture fields must be strings or null"); return; }
                clean.put(name, value);
            }
            boolean alreadySubmitted = false;
            JSONObject old = store.meta(accountId, requestId);
            if (old != null) {
                if (!StoreNames.sha256Hex(bytes).equals(old.optString("imgSha")) || !DraftLifecycle.sameFields(clean, old.optJSONObject("fields"))) {
                    call.reject("clientRequestId reused with different payload"); return;
                }
                alreadySubmitted = "submitted".equals(old.optString("status"));
            } else {
                store.add(accountId, requestId, clean, System.currentTimeMillis(), "pending", bytes);
            }
            if (!alreadySubmitted) UploadScheduler.enqueue(getContext(), accountId, requestId, 0, ExistingWorkPolicy.KEEP);
            JSObject out = new JSObject(); out.put("ok", true); out.put("clientRequestId", requestId); call.resolve(out);
            }
        } catch (Exception e) { call.reject("Could not persist encrypted draft", e); }
    }

    /**
     * Metadata only (no photo is read or decrypted). {@code quarantined} counts drafts that could not be opened any more
     * (the device key was lost) and were set aside, not yet acknowledged with {@link #quarantineAck}.
     */
    @PluginMethod
    public void list(PluginCall call) {
        String accountId = call.getString("accountId", "");
        if (!validAccount(accountId) || !accountId.equals(NativeStore.activeAccount(getContext()))) { call.reject("Activate the matching account first"); return; }
        try {
            OutboxStore.Listing listing = NativeStore.outbox(getContext()).list(accountId); JSONArray output = new JSONArray();
            for (JSONObject row : listing.rows) {
                JSONObject item = new JSONObject();
                item.put("accountId", accountId); item.put("clientRequestId", row.optString("clientRequestId"));
                item.put("fields", row.optJSONObject("fields")); item.put("createdMs", row.optLong("createdMs"));
                item.put("status", row.optString("status", "pending"));
                copyOptional(row, item);
                output.put(item);
            }
            JSObject out = new JSObject(); out.put("drafts", output); out.put("quarantined", listing.quarantined);
            if (listing.quarantinedApprox) out.put("quarantinedApprox", true);
            call.resolve(out);
        } catch (Exception e) { call.reject("Could not read encrypted drafts", e); }
    }

    /** The web has shown the notice about quarantined drafts: stop counting what is set aside today. */
    @PluginMethod
    public void quarantineAck(PluginCall call) {
        String accountId = call.getString("accountId", "");
        if (!owner(accountId)) { call.reject("Activate the matching account first"); return; }
        try {
            NativeStore.outbox(getContext()).acknowledgeQuarantine(accountId);
            JSObject out = new JSObject(); out.put("ok", true); call.resolve(out);
        } catch (Exception e) { call.reject("Could not acknowledge quarantined drafts", e); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String accountId = call.getString("accountId", ""); String requestId = call.getString("clientRequestId", "");
        if (!validAccount(accountId) || !accountId.equals(NativeStore.activeAccount(getContext())) || !ID.matcher(requestId).matches()) { call.reject("Draft owner or id invalid"); return; }
        try {
            UploadScheduler.cancel(getContext(), accountId, requestId);
            synchronized (NativeStore.LOCK) {
                DraftLifecycle.remove(NativeStore.outbox(getContext()), NativeStore.photos(getContext()), accountId, requestId);
            }
            JSObject out = new JSObject(); out.put("ok", true); call.resolve(out);
        } catch (Exception e) { call.reject("Could not remove draft", e); }
    }

    static boolean validAccount(String id) { return id != null && ACCOUNT.matcher(id).matches(); }

    /** Path text that must never reach the server: separators, fragments, userinfo, traversal, encoded slashes, line breaks. */
    private static boolean unsafeText(String text) {
        String lower = text.toLowerCase(Locale.ROOT);
        return text.contains("\\") || text.contains("#") || text.contains("@") || text.contains("..")
                || lower.contains("%2f") || lower.contains("%5c") || text.contains("\r") || text.contains("\n");
    }

    /**
     * {@code /api/records?limit=N&cursor=...} (contract 5.1): only these two parameters, limit 1..500, and an opaque
     * cursor of URL-safe characters or well-formed percent escapes (an encoded cursor may legitimately contain %2F).
     */
    static boolean recordsQueryAllowed(String query) {
        if (query == null || query.isEmpty()) return false;
        boolean limit = false;
        boolean cursor = false;
        for (String pair : query.split("&", -1)) {
            if (pair.startsWith("limit=")) {
                String value = pair.substring(6);
                if (limit || !value.matches("[0-9]{1,3}")) return false;
                int n = Integer.parseInt(value);
                if (n < 1 || n > 500) return false;
                limit = true;
            } else if (pair.startsWith("cursor=")) {
                String value = pair.substring(7);
                if (cursor || value.isEmpty() || value.length() > 1024 || value.contains("..")) return false;
                for (int i = 0; i < value.length(); i++) {
                    char c = value.charAt(i);
                    if (c == '%') {
                        if (i + 2 >= value.length() || Character.digit(value.charAt(i + 1), 16) < 0 || Character.digit(value.charAt(i + 2), 16) < 0) return false;
                        i += 2;
                    } else if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9')
                            && "-._~+=/".indexOf(c) < 0) {
                        return false;
                    }
                }
                cursor = true;
            } else {
                return false;
            }
        }
        return limit || cursor;
    }

    static boolean allowed(String path, String method) {
        if (path == null || path.isEmpty() || path.charAt(0) != '/' || path.startsWith("//")) return false;
        int split = path.indexOf('?');
        String p = split < 0 ? path : path.substring(0, split);
        String query = split < 0 ? null : path.substring(split + 1);
        boolean pagedRecords = query != null && p.equals("/api/records") && method.equals("GET");
        if (pagedRecords) {
            if (!recordsQueryAllowed(query)) return false;
        } else if (query != null && unsafeText(query)) {
            return false;
        }
        if (unsafeText(p)) return false;
        try { URI uri = URI.create(pagedRecords ? p : path); if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null || uri.getRawPath() == null || uri.getRawPath().contains("%")) return false; } catch (Exception e) { return false; }
        if (!(method.equals("GET") || method.equals("POST") || method.equals("PUT") || method.equals("PATCH") || method.equals("DELETE"))) return false;
        if (p.equals("/api/auth/login") || p.equals("/api/auth/register")) return method.equals("POST");
        if (p.equals("/api/auth/google") || p.equals("/api/auth/google/nonce")) return method.equals("POST");
        if (p.equals("/api/auth/google/config")) return method.equals("GET");
        if (p.equals("/api/auth/me")) return method.equals("GET");
        if (p.equals("/api/auth/logout") || p.equals("/api/auth/password")) return method.equals("POST");
        if (p.equals("/api/recommendations")) return method.equals("POST") && query == null;
        if (p.equals("/api/client-errors")) return method.equals("POST") && query == null;
        if (p.equals("/api/telemetry")) return method.equals("GET");
        if (p.equals("/api/queue/pending")) return method.equals("GET");
        if (p.equals("/api/health")) return method.equals("GET");
        if (p.equals("/api/daily")) return method.equals("GET") || method.equals("POST");
        if (p.matches("/api/daily/[A-Za-z0-9_-]{1,128}")) return method.equals("DELETE");
        if (p.equals("/api/farms")) return method.equals("GET") || method.equals("POST");
        if (p.matches("/api/farms/[A-Za-z0-9_-]{1,128}")) return method.equals("PUT") || method.equals("DELETE");
        if (PHOTO_PATH.matcher(p).matches()) return method.equals("GET");
        if (PHOTO_THUMBNAIL_PATH.matcher(p).matches()) return method.equals("GET") && query == null;
        if (p.equals("/api/analyze")) return method.equals("POST");
        if (p.matches("/api/analyze/[A-Za-z0-9_-]{1,128}")) return method.equals("GET");
        if (p.matches("/api/analyze/[A-Za-z0-9_-]{1,128}/ack")) return method.equals("POST");
        if (p.matches("/api/analyze/[A-Za-z0-9_-]{1,128}/cancel")) return method.equals("POST");
        if (p.matches("/api/records/[A-Za-z0-9_-]{1,128}/reanalyze")) return method.equals("POST") && query == null;
        if (p.equals("/api/records")) return method.equals("GET") || method.equals("POST");
        if (p.matches("/api/records/[A-Za-z0-9_-]{1,128}")) return method.equals("PUT") || method.equals("DELETE");
        return false;
    }

    private JSObject perform(String path, String method, JSONObject body, JSONObject session) throws Exception {
        String barePath = path.split("\\?", 2)[0];
        boolean photo = PHOTO_PATH.matcher(barePath).matches();
        boolean thumbnail = PHOTO_THUMBNAIL_PATH.matcher(barePath).matches();
        int responseLimit = thumbnail ? MAX_PHOTO_THUMBNAIL_BYTES : photo ? NativeHttp.MAX_PHOTO_BYTES : NativeHttp.MAX_JSON_BYTES;
        int timeoutMs = NativeHttp.timeoutFor(barePath);
        HttpURLConnection connection = NativeHttp.open(path, method, timeoutMs, timeoutMs);
        if (session != null && !session.optString("cookie", "").isEmpty()) connection.setRequestProperty("Cookie", session.optString("cookie"));
        if (session != null && !session.optString("csrf", "").isEmpty()) connection.setRequestProperty("X-CSRF-Token", session.optString("csrf"));
        int status;
        byte[] bytes;
        String contentType;
        String setCookie;
        try (NativeHttp.Deadline ignored = new NativeHttp.Deadline(connection, photo ? 5 * 60_000L : NativeHttp.deadlineFor(barePath))) {
            if (!method.equals("GET") && !method.equals("DELETE")) {
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8"); connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(payload.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(payload); }
            }
            status = connection.getResponseCode();
            java.io.InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            try { bytes = NativeHttp.readBounded(stream, responseLimit); }
            finally { if (stream != null) stream.close(); }
            contentType = connection.getHeaderField("Content-Type");
            StringBuilder cookieHeader = new StringBuilder();
            for (java.util.Map.Entry<String, java.util.List<String>> header : connection.getHeaderFields().entrySet()) {
                if (header.getKey() != null && header.getKey().equalsIgnoreCase("Set-Cookie")) {
                    for (String value : header.getValue()) { if (cookieHeader.length() > 0) cookieHeader.append('\n'); cookieHeader.append(value); }
                }
            }
            setCookie = cookieHeader.length() == 0 ? null : cookieHeader.toString();
        } finally { connection.disconnect(); }
        String response = new String(bytes, StandardCharsets.UTF_8);
        JSObject out = new JSObject(); out.put("status", status);
        if ((photo || thumbnail) && status >= 200 && status < 300) {
            out.put("body", B64.encode(bytes)); out.put("encoding", "base64");
        } else out.put("body", response);
        if (contentType != null) {
            JSObject headers = new JSObject(); headers.put("content-type", contentType); out.put("headers", headers);
            if (!out.has("encoding") && contentType.toLowerCase(Locale.ROOT).contains("json")) {
                try { out.put("body", new JSONObject(response)); }
                catch (org.json.JSONException notObject) {
                    try { out.put("body", new JSONArray(response)); }
                    catch (org.json.JSONException notJson) { out.put("body", response); }
                }
            }
        }
        if (setCookie != null) out.put("_setCookie", setCookie);
        return out;
    }

    static boolean validSessionCookie(String setCookie) {
        for (String item : (setCookie == null ? "" : setCookie).split("\\n")) {
            String pair = item.split(";", 2)[0].trim();
            if (pair.startsWith("jk_session=") && pair.length() > "jk_session=".length()) {
                for (String attribute : item.split(";")) {
                    String value = attribute.trim();
                    if (value.regionMatches(true, 0, "Max-Age=", 0, 8)) {
                        try { return Long.parseLong(value.substring(8).trim()) > 0; } catch (NumberFormatException ignored) { return false; }
                    }
                    if (value.regionMatches(true, 0, "Expires=", 0, 8)) {
                        try { return new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).parse(value.substring(8).trim()).getTime() > System.currentTimeMillis(); }
                        catch (Exception ignored) { return false; }
                    }
                }
            }
        }
        return false;
    }

    static JSONObject cookieSession(String setCookie, String csrf) throws Exception {
        if (!validSessionCookie(setCookie)) return null;
        JSONObject result = new JSONObject(); result.put("csrf", csrf);
        StringBuilder cookies = new StringBuilder();
        long expiresAtMs = 0;
        String sessionValue = null;
        for (String item : (setCookie == null ? "" : setCookie).split("\\n")) {
            String pair = item.split(";", 2)[0].trim();
            if (pair.startsWith("jk_session=") || pair.startsWith("jk_csrf=")) {
                if (cookies.length() > 0) cookies.append("; "); cookies.append(pair);
                if (pair.startsWith("jk_session=")) {
                    sessionValue = pair.substring("jk_session=".length());
                    for (String attribute : item.split(";")) {
                        String value = attribute.trim();
                        if (value.regionMatches(true, 0, "Max-Age=", 0, 8)) {
                            try { expiresAtMs = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(Long.parseLong(value.substring(8).trim())); }
                            catch (NumberFormatException ignored) { }
                        } else if (value.regionMatches(true, 0, "Expires=", 0, 8)) {
                            try { expiresAtMs = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).parse(value.substring(8).trim()).getTime(); }
                            catch (Exception ignored) { }
                        }
                    }
                }
            }
        }
        if (sessionValue == null || sessionValue.isEmpty()) return null;
        if (expiresAtMs == 0) return null;
        String cookie = cookies.toString(); result.put("cookie", cookie);
        result.put("expiresAtMs", expiresAtMs);
        for (String pair : cookie.split(";\\s*")) if (pair.startsWith("jk_csrf=")) result.put("csrf", pair.substring("jk_csrf=".length()));
        return result;
    }
}
