# Content Packs

This folder is the expansion point for future world/content variants.

How to extend:

1. Copy `packs/template/pack.template.js` to `packs/<pack-id>/pack.js`.
2. Set a unique `id`.
3. Register it via `registerContentPack(pack)` from `content/registry.js`.
4. Boot the game with `contentPackId`.

Notes:

- Packs are normalized against the base pack, so partial overrides are supported.
- Invalid pack shapes fail fast in `content/registry.js`.
- Base pack source lives at `packs/base-void/pack.js`.

Example future packs:

- `packs/desertVoidPack.js`
- `packs/industrialVoidPack.js`
- `packs/nightSkyPack.js`
