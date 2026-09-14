# Offline PPT player

Build with `node scripts/buildPptPlayer.mjs /path/to/bento` using a clean Bento checkout at `cc038183dbf79a33bee7fe49d0aa1c23f7224874` with its locked slides dependencies installed. No frontend sibling checkout is read by the build.

The Octo code integration, Chinese messages, presenter and controls are vendored in `vendor/`. The native code module retains its upstream license and provenance. When changing a shared implementation in octo-docs-module, update these vendored inputs in the same delivery and rebuild both players. `src/ppt/offlineHost.ts` is a checked-in copy of the frontend offline wrapper. `assets/ppt/provenance.json` records every local source input hash and the generated player hash. Rebuild twice to verify identical outputs.
