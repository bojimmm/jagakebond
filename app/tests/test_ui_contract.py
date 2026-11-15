from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "frontend/index.html").read_text()
CSS = (ROOT / "frontend/styles.css").read_text()
SW = (ROOT / "frontend/sw.js").read_text()


class UiContractTests(unittest.TestCase):
    def test_versioned_offline_modules_precede_app(self):
        expected = ['native-adapter.js', 'offline-store.js', 'offline-sync.js', 'app.js']
        matches = [re.search(r'src="' + re.escape(item) + r'\?v=\d+"', HTML) for item in expected]
        self.assertTrue(all(matches), 'Offline modules must be versioned')
        positions = [match.start() for match in matches]
        self.assertEqual(positions, sorted(positions))

    def test_sync_status_controls_are_accessible_and_wired(self):
        self.assertRegex(HTML, r'id="sync-status"[^>]*aria-live="polite"')
        self.assertIn('id="sync-pending-count"', HTML)
        self.assertRegex(HTML, r'id="sync-retry"[^>]*data-act="syncPendingDrafts"')
        self.assertIn('id="offline-drafts"', HTML)

    def test_auth_uses_local_farm_assets_and_brand_copy(self):
        from PIL import Image
        self.assertIn("img/landing-farmer.webp?v=1", HTML)
        self.assertIn("img/landing-app-home.png?v=5", HTML)
        self.assertIn("img/landing-app-map.png?v=4", HTML)
        self.assertIn("img/landing-app-history.png?v=8", HTML)
        self.assertNotIn('src="/img/crops/', HTML)
        with Image.open(ROOT / "frontend/img/landing-app-history.png") as preview:
            self.assertGreater(preview.width, 500, 'Preview must retain readable app detail')
        self.assertNotRegex(HTML, r"(?i)facebook|meta platforms")
        self.assertIn('alt="Contoh Beranda JagaKebond', HTML)
        self.assertIn('alt="Contoh Riwayat Cabai', HTML)
        self.assertIn('id="auth-gate"', HTML)
        self.assertIn('class="auth-brand-panel"', HTML)
        self.assertIn('privacy.html', HTML)
        self.assertIn('terms.html', HTML)
        self.assertIn("#auth-gate.hidden { display: none !important; }", CSS)
        self.assertIn("z-index: var(--jk-z-auth)", CSS)

    def test_responsive_workspace_states_exist(self):
        self.assertRegex(CSS, r"@media\s*\(min-width:\s*1024px\)")
        self.assertRegex(CSS, r"@media\s*\(min-width:\s*768px\)")
        self.assertIn("prefers-reduced-motion", CSS)
        self.assertIn("min-height: 44px", CSS)
        self.assertIn('id="desktop-nav"', HTML)
        self.assertIn("grid-template-areas", CSS)

    def test_runtime_boot_dependencies_are_local(self):
        # A canonical link is identity metadata, not a downloaded runtime asset.
        runtime_tags = [tag for tag in re.findall(r'<(?:script|link)\b[^>]*>', HTML)
                        if not re.search(r'rel="canonical"', tag)]
        remote = [url for tag in runtime_tags
                  for url in re.findall(r'(?:src|href)="(https?://[^\"]+)', tag)]
        self.assertEqual(remote, [])
        for path in (
            "vendor/tailwind.generated.css", "vendor/lucide-0.468.0.umd.min.js",
            "vendor/leaflet/leaflet-1.9.4.js", "vendor/leaflet/leaflet-1.9.4.css",
            "vendor/exifr/exifr-7.1.3.umd.js", "vendor/fonts/inter/inter.css",
        ):
            self.assertTrue((ROOT / "frontend" / path).is_file(), path)

    def test_viewport_can_zoom_and_auth_forms_have_accessible_styles(self):
        self.assertNotIn("user-scalable=no", HTML)
        self.assertIn(".field {", CSS)
        self.assertIn("#auth-gate.hidden", CSS)
        self.assertIn("z-index: var(--jk-z-auth)", CSS)
        self.assertIn('id="desktop-nav"', HTML)

    def test_offline_shell_revision_contains_brand_assets_and_new_versions(self):
        references = re.findall(r'<(?:script|link)[^>]+(?:src|href)="([^\"]+)"', HTML)
        for item in references:
            if item.startswith(('https:', 'http:', '#')):
                continue
            self.assertIn('/' + item.lstrip('/'), SW, 'Missing install-cache reference: ' + item)
        self.assertIn('/vendor/fonts/google-sans/GoogleSans-latin.woff', SW)
        self.assertIn('Google Sans', CSS)
        self.assertRegex(SW, r"const SHELL_CACHE = 'jk-v\d+';")

    def test_preserves_3_by_4_camera_ratio_and_no_butuh_obat_or_msl_claim(self):
        self.assertIn("aspect-[3/4]", HTML)
        self.assertNotIn("butuh obat", HTML.lower())
        self.assertNotIn("Ketinggian MSL", HTML)

    def test_tailwind_build_scans_sources_and_keeps_hidden_overlays_hidden(self):
        build_dir = ROOT.parent / "review" / "ui-build"
        subprocess.run(["npm", "run", "build:css"], cwd=build_dir, check=True,
                       capture_output=True, text=True)
        compiled = (ROOT / "frontend/vendor/tailwind.generated.css").read_text()
        for selector in (".hidden{", ".flex{", ".absolute{", ".grid{", ".w-full{", ".fixed{"):
            self.assertIn(selector, compiled, f"missing compiled utility {selector}")
        for modal_id in ("modal-crop-assign", "modal-status", "modal-daily", "photo-viewer"):
            self.assertRegex(HTML, rf'id="{modal_id}" class="hidden\b')
        self.assertLess(len(compiled), 350_000, "compiled CSS should not contain broad color safelists")

    def test_landing_revisions_and_bilingual_contract(self):
        landing_css = (ROOT / "frontend/landing.css").read_text()
        i18n_js = (ROOT / "frontend/i18n.js").read_text()

        # Hero fills viewport so the lower band does not peek at initial load, and header CTA stays compact.
        self.assertIn("min-height: 100svh;", landing_css)
        self.assertRegex(landing_css, r"#auth-gate \.topbar-cta\s*\{[^}]*min-height:\s*36px;")

        # Eyebrow headings removed in favor of direct section headlines.
        for removed_eyebrow in ("VIDEO PANDUAN 20 DETIK", "MANFAAT UTAMA", "MASALAH DI LAPANGAN", "Tutorial interaktif 3D"):
            self.assertNotIn(removed_eyebrow, HTML)
        for direct_heading in (
            "Lihat cara kerja JagaKebond dari kebun hingga peta.",
            "Yang Anda dapat dari setiap foto.",
            "Catatan kebun sering tercecer di galeri.",
            "Langkah penggunaan JagaKebond secara visual.",
            "Pertanyaan yang sering muncul.",
        ):
            self.assertIn(direct_heading, HTML)

        # Problem comparison + proof pills + Android offline footnote + borderless autoplay video.
        self.assertIn("Tanpa JagaKebond", HTML)
        self.assertNotIn("Tanpa catatan terstruktur", HTML)
        for pill in (
            "Aplikasi Web",
            "Aplikasi Android",
            "Antarmuka Bilingual",
            "Data Tersimpan di Cloud",
            "Aplikasi Bekerja Offline*",
            "*fitur ini bekerja di aplikasi native Android",
        ):
            self.assertIn(pill, HTML)
        self.assertIn('data-lucide="cloud"', HTML)
        video_match = re.search(r'<video\s+id="explainer-video"[^>]*>', HTML)
        self.assertIsNotNone(video_match)
        self.assertIn("autoplay", video_match.group(0))
        self.assertIn("muted", video_match.group(0))
        self.assertIn("playsinline", video_match.group(0))
        self.assertNotIn("controls", video_match.group(0))
        self.assertRegex(landing_css, r"#auth-gate \.video-shell\s*\{[^}]*border:\s*0;[^}]*padding:\s*0;")

        # Bilingual switch & i18n module across landing, account modal, legal pages, and 3D tour.
        self.assertRegex(HTML, r'src="i18n\.js\?v=\d+"')
        self.assertIn('/i18n.js?v=', SW)
        self.assertIn("STORAGE_KEY = 'jk_lang'", i18n_js)
        for page_name in ("index.html", "privacy.html", "terms.html", "tutorial-3d.html"):
            page = (ROOT / "frontend" / page_name).read_text()
            self.assertIn('data-lang-choice="id"', page, page_name)
            self.assertIn('data-lang-choice="en"', page, page_name)
        self.assertIn('class="info-row info-row-lang"', HTML)

        # APK downloads, Tutorial top nav rename, botanical ornaments, #fitur thumbnails, and ` | ` <title>.
        self.assertIn('href="#cara">Tutorial</a>', HTML)
        self.assertNotIn('href="#cara">Tutorial 3D</a>', HTML)
        self.assertEqual(HTML.count('href="/downloads/jagakebond-latest.apk"'), 3)
        self.assertIn("'/downloads/'", SW)
        for img_name in (
            "ornament-botanical-canopy.webp",
            "ornament-contour-ridge.webp",
            "ornament-botanical-corner.webp",
            "feature-diagnosis.webp",
            "feature-history.webp",
            "feature-map.webp",
            "feature-offline.webp",
        ):
            self.assertIn(img_name, HTML)
            self.assertIn(f"/img/{img_name}", SW)
            self.assertTrue((ROOT / "frontend" / "img" / img_name).exists(), img_name)
        for page_name in ("index.html", "admin.html", "privacy.html", "terms.html", "tutorial-3d.html"):
            page = (ROOT / "frontend" / page_name).read_text()
            title_match = re.search(r"<title>([^<]+)</title>", page)
            self.assertIsNotNone(title_match, page_name)
            self.assertIn(" | ", title_match.group(1), page_name)
            self.assertNotIn("—", title_match.group(1), page_name)
            self.assertNotIn("·", title_match.group(1), page_name)


if __name__ == "__main__":
    unittest.main()
