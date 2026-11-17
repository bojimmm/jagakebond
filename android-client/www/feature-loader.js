/* Local, offline-cacheable feature libraries. No remote code or arbitrary URLs. */
(function (root) {
  "use strict";
  const groups = {
    map: [
      ["vendor/leaflet/leaflet-1.9.4.js", () => !!root.L],
      ["vendor/turf.min.js", () => !!root.turf],
      ["vendor/leaflet-geoman.min.js", () => !!root.L?.PM],
    ],
    photoMetadata: [["vendor/exifr/exifr-7.1.3.umd.js", () => !!root.exifr]],
    photoExport: [["vendor/piexifjs/piexif.js", () => !!root.piexif]],
  };
  const pending = new Map();
  function script(path, ready) {
    if (ready()) return Promise.resolve();
    if (pending.has(path)) return pending.get(path);
    const request = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = path;
      el.async = true;
      const timer = setTimeout(() => fail(), 20000);
      function fail() {
        clearTimeout(timer);
        el.remove();
        pending.delete(path);
        reject(
          Error("Alat belum dapat dimuat. Periksa sambungan lalu coba lagi."),
        );
      }
      el.onerror = fail;
      el.onload = () => {
        clearTimeout(timer);
        if (ready()) resolve();
        else fail();
      };
      document.head.append(el);
    });
    pending.set(path, request);
    return request;
  }
  async function load(name) {
    if (!Object.prototype.hasOwnProperty.call(groups, name))
      throw Error("Fitur tidak dikenal.");
    for (const [path, ready] of groups[name]) await script(path, ready);
  }
  root.JagaFeatures = { load };
})(window);
