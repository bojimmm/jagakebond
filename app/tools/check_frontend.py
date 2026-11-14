"""Static check of the single-file frontend.

A no-build `index.html` has no compiler, so renaming a function quietly becomes a
runtime ReferenceError in whichever handler happened to call the old name. This
catches that class of bug (and duplicate definitions) before it ships.

Usage:  python tools/check_frontend.py [path/to/index.html]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DEFAULT = Path(__file__).resolve().parent.parent / "frontend" / "index.html"

# Globals and host APIs the frontend legitimately calls.
ALLOWED = {
    # language / platform
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch", "JSON", "Object",
    "Array", "String", "Number", "Boolean", "Math", "Date", "Promise", "Map", "Set", "Blob",
    "File", "FormData", "URL", "Image", "atob", "btoa", "console", "parseInt", "parseFloat",
    "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "requestAnimationFrame",
    "alert", "confirm", "prompt", "structuredClone", "queueMicrotask", "Intl", "RegExp",
    "Error", "TypeError", "RangeError", "Symbol", "WeakMap", "WeakSet", "localStorage",
    "sessionStorage", "navigator", "document", "window", "globalThis", "getComputedStyle",
    "matchMedia", "crypto", "AbortController", "CustomEvent", "Event", "TextEncoder", "BroadcastChannel", "MessageChannel",
    "TextDecoder", "Uint8Array", "Float32Array", "ArrayBuffer", "createImageBitmap",
    "addEventListener", "removeEventListener", "URLSearchParams", "Date",
    # more host APIs the browser provides
    "FileReader", "SpeechSynthesisUtterance", "SpeechSynthesisEvent", "performance",
    "location", "history", "screen", "Headers", "Request", "Response", "DataTransfer",
    "IntersectionObserver", "ResizeObserver", "MutationObserver", "Notification",
    "Worker", "MediaRecorder", "XMLHttpRequest", "DOMParser", "Audio", "Option",
    "ClipboardEvent", "KeyboardEvent", "PointerEvent", "TouchEvent", "DragEvent",
    # libraries loaded from CDN / vendored
    "L", "turf", "lucide", "exifr", "tailwind",
    # control flow keywords
    "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new",
    "do", "else", "try", "throw", "delete", "in", "of", "case", "void", "yield",
    # promise executor params and common callback names
    "resolve", "reject", "async",
}


def strip_literals(code: str) -> str:
    """Replace string/template/regex literals and comments with spaces.

    Needs to be right, not merely quick: a naive scanner desynchronises on regex
    literals (`.replace(/"/g, ...)`) and on nested template literals
    (`` `${cond ? `inner` : ''}` ``), and a desync silently swallows real code —
    making the checker report false results in both directions.
    """
    out: list[str] = []
    index = 0
    length = len(code)
    stack: list[tuple[str, int]] = [("code", 0)]
    regex_prefixes = set("(,=:[!&|?{};\n+-*%~^<>") | {""}

    def previous_code_char() -> str:
        for char in reversed(out):
            if char not in " \t":
                return char
        return ""

    while index < length:
        mode = stack[-1][0]
        char = code[index]
        nxt = code[index + 1] if index + 1 < length else ""

        if mode == "template":
            if char == "\\":
                out.append(" ")
                index += 2
                continue
            if char == "`":
                stack.pop()
                out.append(" ")
                index += 1
                continue
            if char == "$" and nxt == "{":
                stack.append(("code", 0))
                out.append(" ")
                index += 2
                continue
            out.append(" ")
            index += 1
            continue

        # mode == "code"
        if char == "/" and nxt == "/":
            end = code.find("\n", index)
            index = length if end == -1 else end
            continue
        if char == "/" and nxt == "*":
            end = code.find("*/", index + 2)
            index = length if end == -1 else end + 2
            continue
        if char == "`":
            stack.append(("template", 0))
            out.append(" ")
            index += 1
            continue
        if char in "\"'":
            quote = char
            index += 1
            while index < length:
                if code[index] == "\\":
                    index += 2
                    continue
                if code[index] == quote:
                    index += 1
                    break
                index += 1
            out.append(" ")
            continue
        if char == "/" and previous_code_char() in regex_prefixes:
            index += 1
            in_class = False
            while index < length:
                current = code[index]
                if current == "\\":
                    index += 2
                    continue
                if current == "[":
                    in_class = True
                elif current == "]":
                    in_class = False
                elif current == "/" and not in_class:
                    index += 1
                    while index < length and code[index].isalpha():
                        index += 1
                    break
                elif current == "\n":
                    break
                index += 1
            out.append(" ")
            continue
        if char == "{":
            stack[-1] = ("code", stack[-1][1] + 1)
        elif char == "}":
            if stack[-1][1] == 0 and len(stack) > 1:
                stack.pop()  # closes a ${ } interpolation
                out.append(" ")
                index += 1
                continue
            stack[-1] = ("code", max(0, stack[-1][1] - 1))
        out.append(char)
        index += 1

    return "".join(out)


def is_iife_module(code: str) -> bool:
    body = re.sub(r"^\s*(?:/\*.*?\*/\s*|//[^\n]*\n\s*)*", "", code, flags=re.S)
    return body.startswith("(function")


def top_level_lexical(code: str) -> set[str]:
    """`let`/`const`/`class` declared at brace depth 0 of a classic script. They live in the shared global
    lexical scope: the same name in two scripts is a SyntaxError that stops the second script entirely."""
    stripped = strip_literals(code)
    names: set[str] = set()
    depth = 0
    for match in re.finditer(r"[{}]|\b(?:let|const|class)\s+([A-Za-z_$][\w$]*)", stripped):
        token = match.group(0)
        if token == "{":
            depth += 1
        elif token == "}":
            depth = max(0, depth - 1)
        elif depth == 0 and match.group(1):
            names.add(match.group(1))
    return names


def global_lexical_clashes(files: list[Path]) -> list[str]:
    seen: dict[str, str] = {}
    out: list[str] = []
    for file in files:
        for name in sorted(top_level_lexical(file.read_text(encoding="utf-8"))):
            if name in seen and seen[name] != file.name:
                out.append(f"global '{name}' declared in {seen[name]} and {file.name}")
            seen.setdefault(name, file.name)
    return out


def shell_cache_mismatches(path: Path, html: str) -> list[str]:
    """index.html and the service worker's SHELL_ASSETS must name the same ?v= for every local js/css asset."""
    sw = path.parent / "sw.js"
    if not sw.exists():
        return []
    shell: dict[str, str] = {}
    for asset in re.findall(r"'(/[^']+)'", sw.read_text(encoding="utf-8").split("];")[0]):
        name, _, query = asset.lstrip("/").partition("?")
        shell[name] = query
    out: list[str] = []
    for ref in re.findall(r'(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"', html):
        if ref.startswith("http"):
            continue
        name, _, query = ref.lstrip("/").partition("?")
        if name not in shell:
            out.append(f"{name} is not in sw.js SHELL_ASSETS")
        elif shell[name] != query:
            out.append(f"{name}: index.html ?{query} but sw.js ?{shell[name]}")
    return out


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    html = path.read_text(encoding="utf-8")

    # The app code can be inline (single-file build) or an external app.js that
    # sits next to index.html. Support both so this tool keeps guarding whichever
    # layout the frontend currently uses.
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
    inline_app = [block for block in scripts if "JagaKebond PWA" in block]
    external = path.parent / "app.js"
    problems: list[str] = []
    if inline_app:
        code_sources = inline_app
        source_label = "inline <script> in " + path.name
    elif external.exists():
        # Every local (non-vendor) script the page loads, in load order: since 0.2.2.0 the field app is split over
        # app.js, session.js, scan-flow.js, shell.js and workflow-ui.js, and they share one global scope.
        local = [src.split("?")[0] for src in re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', html)
                 if not src.startswith(("vendor/", "/vendor/", "http"))]
        files = [path.parent / name.lstrip("/") for name in local]
        missing = [f.name for f in files if not f.exists()]
        if missing:
            problems.append("missing scripts: " + ", ".join(missing))
        files = [f for f in files if f.exists()]
        if external not in files:
            files.insert(0, external)
        # Self-contained modules (an IIFE that only publishes window.X) keep their names private; only the
        # scripts that share the page's global scope are checked for undefined calls and duplicate functions.
        shared = [f for f in files if not is_iife_module(f.read_text(encoding="utf-8"))]
        code_sources = [f.read_text(encoding="utf-8") for f in shared]
        source_label = ", ".join(f.name for f in shared)
        problems += global_lexical_clashes(files)
        problems += shell_cache_mismatches(path, html)
    else:
        print("FAIL: no app code found in", path, "and no sibling app.js")
        return 1

    app = "\n;\n".join(code_sources)
    code = strip_literals(app)

    defined = set(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", code))
    defined |= set(re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", code))
    for match in re.finditer(r"\(([^)]*)\)\s*=>", code):  # arrow-function parameters
        for param in match.group(1).split(","):
            name = param.strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", name or ""):
                defined.add(name)
    for match in re.finditer(r"function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)", code):
        for param in match.group(1).split(","):
            name = param.strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", name or ""):
                defined.add(name)
    # Object-literal method shorthand (`handleBack() {`, `close() {`) defines a property, not a call.
    for match in re.finditer(r"(?:^|[\n,{])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{", code):
        if match.group(1) not in {"if", "for", "while", "switch", "catch", "function"}:
            defined.add(match.group(1))
    declared = set(defined)

    called_code = {
        m.group(1) for m in re.finditer(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(", code)
    }
    handler_calls: set[str] = set()
    for handler in re.findall(r'on\w+="([^"]*)"', html):
        handler_calls |= {
            m.group(1) for m in re.finditer(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(", handler)
        }

    undefined = sorted(
        name for name in (called_code | handler_calls)
        if name not in declared and name not in ALLOWED
    )

    counts: dict[str, int] = {}
    for name in re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", code):
        counts[name] = counts.get(name, 0) + 1
    duplicates = sorted(name for name, count in counts.items() if count > 1)

    handlers_defined = {
        m.group(1) for m in re.finditer(r'on\w+="([^"]*)"', html)
        for m in re.finditer(r"([A-Za-z_$][\w$]*)\s*\(", m.group(1))
    }
    print(f"html                : {path}")
    print(f"code checked        : {source_label}")
    print(f"html lines          : {html.count(chr(10)) + 1}")
    print(f"defined identifiers : {len(declared)}")
    print(f"call sites in code  : {len(called_code)}")
    print(f"inline handler calls: {len(handlers_defined)}")
    print()
    print("undefined calls in code     :", undefined or "none")
    print("duplicate function defs     :", duplicates or "none")

    print("load-order / cache problems:", problems or "none")
    ok = not undefined and not duplicates and not problems
    print()
    print("RESULT:", "OK" if ok else "PROBLEMS FOUND")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
