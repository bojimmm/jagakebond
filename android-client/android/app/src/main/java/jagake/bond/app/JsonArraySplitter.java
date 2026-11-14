package jagake.bond.app;

import java.nio.charset.StandardCharsets;

/**
 * Walks the top-level elements of a JSON array held as UTF-8 bytes without building the whole document tree.
 * Used to migrate the legacy single-blob outbox one draft at a time: peak memory is the decrypted array plus one
 * element instead of several full copies. Structural characters are ASCII, so scanning bytes is UTF-8 safe.
 */
final class JsonArraySplitter {
    private final byte[] data;
    private int position;
    private boolean finished;

    /** @throws IllegalArgumentException when the bytes do not start with an array. */
    JsonArraySplitter(byte[] data) {
        this.data = data;
        skipWhitespace();
        if (position >= data.length || data[position] != '[') throw malformed("array expected");
        position++;
    }

    /** @throws IllegalArgumentException when the array is malformed. */
    boolean hasNext() {
        if (finished) return false;
        skipWhitespace();
        if (position >= data.length) throw malformed("unterminated array");
        if (data[position] == ']') {
            position++;
            skipWhitespace();
            if (position != data.length) throw malformed("trailing data");
            finished = true;
            return false;
        }
        return true;
    }

    /** Returns the JSON text of the next element. */
    String next() {
        skipWhitespace();
        int start = position;
        int end = scanValue();
        String text = new String(data, start, end - start, StandardCharsets.UTF_8);
        position = end;
        skipWhitespace();
        if (position >= data.length) throw malformed("unterminated array");
        if (data[position] == ',') {
            position++;
            skipWhitespace();
            if (position < data.length && data[position] == ']') throw malformed("trailing comma");
        } else if (data[position] != ']') {
            throw malformed("comma expected");
        }
        return text;
    }

    private int scanValue() {
        if (position >= data.length) throw malformed("value expected");
        byte first = data[position];
        if (first == '"') return scanString(position);
        if (first == '{' || first == '[') {
            int depth = 0;
            int i = position;
            while (i < data.length) {
                byte b = data[i];
                if (b == '"') { i = scanString(i); continue; }
                if (b == '{' || b == '[') depth++;
                else if (b == '}' || b == ']') {
                    depth--;
                    if (depth == 0) return i + 1;
                    if (depth < 0) throw malformed("unbalanced");
                }
                i++;
            }
            throw malformed("unterminated value");
        }
        int i = position;
        while (i < data.length && data[i] != ',' && data[i] != ']' && data[i] != '}'
                && data[i] != ' ' && data[i] != '\n' && data[i] != '\r' && data[i] != '\t') i++;
        if (i == position) throw malformed("empty value");
        return i;
    }

    /** @return index just after the closing quote of the string that starts at {@code from}. */
    private int scanString(int from) {
        int i = from + 1;
        while (i < data.length) {
            byte b = data[i];
            if (b == '\\') { i += 2; continue; }
            if (b == '"') return i + 1;
            i++;
        }
        throw malformed("unterminated string");
    }

    private void skipWhitespace() {
        while (position < data.length) {
            byte b = data[position];
            if (b == ' ' || b == '\n' || b == '\r' || b == '\t') position++;
            else break;
        }
    }

    private static IllegalArgumentException malformed(String why) {
        return new IllegalArgumentException("Malformed JSON array: " + why);
    }
}
