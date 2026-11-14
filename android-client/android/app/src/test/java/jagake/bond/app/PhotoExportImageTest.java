package jagake.bond.app;
import org.junit.Test;
import static org.junit.Assert.*;
public class PhotoExportImageTest {
 @Test public void acceptsBoundedJpeg(){byte[] image={(byte)255,(byte)216,1,2};assertArrayEquals(image,PhotoExportImage.decode(B64.encode(image),4));}
 @Test(expected=IllegalArgumentException.class) public void rejectsNonJpeg(){PhotoExportImage.decode(B64.encode(new byte[]{1,2,3,4}),100);}
 @Test(expected=IllegalArgumentException.class) public void rejectsDecodedOversize(){PhotoExportImage.decode(B64.encode(new byte[]{(byte)255,(byte)216,1,2,3}),4);}
 @Test(expected=IllegalArgumentException.class) public void rejectsEncodedOversize(){PhotoExportImage.decode(new String(new char[1000]).replace('\0','A'),4);}
}
