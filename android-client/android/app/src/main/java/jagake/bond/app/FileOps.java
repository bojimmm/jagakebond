package jagake.bond.app;

import java.io.File;
import java.io.IOException;

/** Durable file mutations. {@link OsFiles} on Android, a java.nio implementation (with fault injection) in JVM tests. */
interface FileOps {
    /** Create a directory (owner-only) and make its creation durable. No-op when it already exists. */
    void mkdirs(File dir) throws IOException;

    /** Write the concatenated parts to a temporary sibling, fsync it, atomically rename it over {@code target}, fsync the directory. */
    void writeDurable(File target, byte[]... parts) throws IOException;

    /** Atomically rename (replacing the destination) and fsync the affected directories. */
    void renameDurable(File from, File to) throws IOException;

    /** Best-effort delete. @return true when the file no longer exists. */
    boolean delete(File file);

    void syncDir(File dir) throws IOException;
}
