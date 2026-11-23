# Third-party assets (pinned)

| File | Upstream | Version | License |
|---|---|---|---|
| `vendor/three.r134.min.js` | https://github.com/mrdoob/three.js | r134 (npm three@0.134.0) | MIT — `THREE-LICENSE.txt` |
| `vendor/vanta.waves.0.5.24.min.js` | https://github.com/tengbao/vanta | 0.5.24 | MIT — `VANTA-LICENSE.txt` |
| `vendor/fluid/fluid.js` | adapted from https://github.com/PavelDoGreat/WebGL-Fluid-Simulation | master snapshot 2026-11-17 | MIT — `WEBGL-FLUID-LICENSE.txt` |

`vendor/fluid/fluid.js` keeps the upstream Navier–Stokes GPU pipeline and is
reduced to a managed factory: no bloom/sunrays/dithering, no global canvas or
`preventDefault`, 30 fps cap, passive pointer input, autonomous splats and
destroy(). See the file header for the change list.

Downloaded from unpkg/raw.githubusercontent.com on 2026-11-17 and stored locally:
the PWA never loads these from a CDN at runtime.
