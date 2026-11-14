# Owner phone fixes for the guide and the plot sheet

Release candidate: 0.2.4.13 / Android versionCode 41 / cache jk-v47. Built on live 0.2.4.12.

1. Guide, Kamera step: the ring now covers the raised round camera button, not only the nav button's own box (the button grew in 0.2.2.x and sits above the bar).
2. Guide replayed from Akun → Panduan penggunaan: the Akun sheet closes first and the guide starts on Beranda, so no step is hidden behind the sheet. Closing the guide stays on Beranda.
3. Peta, tapping a petak: each plant in it is shown as the same card as Beranda "Perlu perhatian" (photo, condition, status badge, date), most urgent first. Tapping a card still opens that plant's detail on the map.

Tests: tour-0252.cjs (replay and Kamera-ring checks), ui-217-parent.cjs (plot card check).
