package jagake.bond.app;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** {@link FileOps} on Android: owner-only files, fsync of the file and of its directory, atomic rename. */
final class OsFiles implements FileOps {
    @Override public void mkdirs(File dir) throws IOException {
        if (dir.isDirectory()) return;
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("Could not create directory");
        try {
            Os.chmod(dir.getAbsolutePath(), 0700);
        } catch (ErrnoException ignored) {
            // The no-backup directory is already private to the app; the mode is defence in depth.
        }
        syncDir(dir.getParentFile());
    }

    @Override public void writeDurable(File target, byte[]... parts) throws IOException {
        File temp = new File(target.getParentFile(), target.getName() + ".tmp");
        try {
            if (temp.exists() && !temp.delete()) throw new IOException("Could not clean stale encrypted-write temporary file");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                Os.chmod(temp.getAbsolutePath(), 0600);
                for (byte[] part : parts) out.write(part);
                out.getFD().sync();
            }
            Os.rename(temp.getAbsolutePath(), target.getAbsolutePath());
            syncDir(target.getParentFile());
        } catch (ErrnoException e) {
            if (temp.exists()) temp.delete();
            throw new IOException("Encrypted write failed: " + e.getMessage(), e);
        } catch (IOException | RuntimeException e) {
            if (temp.exists()) temp.delete();
            throw e;
        }
    }

    @Override public void renameDurable(File from, File to) throws IOException {
        try {
            Os.rename(from.getAbsolutePath(), to.getAbsolutePath());
        } catch (ErrnoException e) {
            throw new IOException("Rename failed: " + e.getMessage(), e);
        }
        syncDir(to.getParentFile());
        if (!from.getParentFile().equals(to.getParentFile())) syncDir(from.getParentFile());
    }

    @Override public boolean delete(File file) {
        return file.delete() || !file.exists();
    }

    @Override public void syncDir(File directory) throws IOException {
        try {
            java.io.FileDescriptor descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            try { Os.fsync(descriptor); }
            finally { Os.close(descriptor); }
        } catch (ErrnoException e) {
            throw new IOException("Directory sync failed: " + e.getMessage(), e);
        }
    }
}
