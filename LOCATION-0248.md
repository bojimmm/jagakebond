# Manual photo-location map: one current-location control (0.2.4.8)

The manual location editor had both the newer `Ke lokasi saya` control and the older `Pusatkan ke pin` control. The older duplicate is removed. The editor now displays one location control, `Ke lokasi saya`, beside Leaflet's regular zoom buttons.

The retained control recentres on the phone's current GPS position (using the current fix or requesting one). It does not change the pin selected for the photo. The normal Peta screen keeps its own location control.

No API, database, quota, account, or photo-storage behavior changes. The Android WebView mirror uses the same JavaScript and CSS as the web frontend.