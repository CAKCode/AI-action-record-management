# pytest-html video player assets

These browser distributions are vendored so managed pytest HTML reports do not
depend on client access to a CDN. `server.js` verifies each file's SHA-256
before accepting traffic and only replaces the exact source URLs listed below.

| File | Upstream URL | License |
| --- | --- | --- |
| `hls.min.js` | `https://cdn.jsdelivr.net/npm/hls.js@1.7.1/dist/hls.min.js` | Apache-2.0 |
| `flv.min.js` | `https://cdn.jsdelivr.net/npm/flv.js@latest/dist/flv.min.js` | Apache-2.0 |
| `dash.all.min.js` | `https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js` | BSD-3-Clause |
| `shaka-player.compiled.js` | `https://cdn.jsdelivr.net/npm/shaka-player@4.15.15/dist/shaka-player.compiled.js` | Apache-2.0 |

For historical reports, the platform also replaces the former HLS.js `1.5.15`
CDN URL with this `1.7.1` build. The newer parser supports HEVC in MPEG-TS;
decoding still requires HEVC support in the browser and operating system.
