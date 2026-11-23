# Third-party notices

This repository contains original application code plus a small number of
vendored browser libraries. The MIT license in `LICENSE` covers the original
code only.

Vendored assets under `site/vendor/`:

| Component | Version | License | License file |
|---|---|---|---|
| Dexie.js | 4.4.7 | Apache-2.0 | `site/vendor/dexie.LICENSE.txt`, `dexie.NOTICE.txt` |
| ts-fsrs | 6.0.0 | MIT | `site/vendor/ts-fsrs.LICENSE.txt` |
| Three.js | r134 | MIT | `site/vendor/third-party-licenses/THREE-LICENSE.txt` |
| Vanta.js (waves) | 0.5.24 | MIT | `site/vendor/third-party-licenses/VANTA-LICENSE.txt` |
| WebGL Fluid Simulation | — | MIT | `site/vendor/third-party-licenses/WEBGL-FLUID-LICENSE.txt` |

Development and backend dependencies (installed from npm, not vendored):
Playwright (Apache-2.0), esbuild (MIT), Wrangler (MIT OR Apache-2.0),
workerd (Apache-2.0), Dexie (Apache-2.0), ts-fsrs (MIT).

Keep the license files when redistributing the `site/` directory.
