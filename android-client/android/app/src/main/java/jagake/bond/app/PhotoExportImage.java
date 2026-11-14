package jagake.bond.app;
/** Bounded decoding for a rendered export; private originals are never replaced. */
final class PhotoExportImage {
    static byte[] decode(String image,int maxBytes) {
        if(image==null||image.isEmpty()||image.length()>((long)maxBytes+2)/3*4+4)throw new IllegalArgumentException("Photo export exceeds size limit");
        byte[] bytes=B64.decode(image);
        if(bytes.length<4||bytes.length>maxBytes||(bytes[0]&255)!=255||(bytes[1]&255)!=216)throw new IllegalArgumentException("Photo export must be JPEG");
        return bytes;
    }
}
