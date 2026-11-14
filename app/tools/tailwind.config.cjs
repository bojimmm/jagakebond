const path = require('path');
const frontend = path.resolve(__dirname, '../frontend');

module.exports = {
  content: [
    path.join(frontend, 'index.html'),
    path.join(frontend, 'app.js'),
    // WEB 0.2.2.0: the field app is split over these scripts (they build markup with utility classes too).
    path.join(frontend, 'session.js'),
    path.join(frontend, 'scan-flow.js'),
    path.join(frontend, 'shell.js'),
    path.join(frontend, 'workflow-ui.js'),
    path.join(frontend, 'admin.html'),
    path.join(frontend, 'admin.js'),
    path.join(frontend, 'styles.css'),
  ],
  safelist: [
    'text-red-600', 'text-amber-600', 'bg-farm-500/10', 'ring-farm-500/25',
  ],
  theme: {
    extend: {
      colors: {
        farm: {
          50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac',
          400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d',
          800: '#166534', 900: '#14532d',
        },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(15, 23, 42, 0.04), 0 1px 3px 0 rgba(15, 23, 42, 0.06)',
        raised: '0 10px 25px -12px rgba(15, 23, 42, 0.35)',
      },
    },
  },
  plugins: [],
};
