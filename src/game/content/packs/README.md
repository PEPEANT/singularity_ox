# Packs Folder

Each pack should live in its own folder:

1. `packs/<pack-id>/pack.js`
2. Optional local docs/assets for that pack.

Current pack:

- `packs/base-void/pack.js`

Compatibility note:

- `packs/baseVoidPack.js` re-exports the base pack for legacy imports.

Recommended workflow for new packs:

1. Copy `packs/template/pack.template.js`.
2. Change `id` and `name`.
3. Override only the fields that differ from base.
4. Register with `registerContentPack(...)`.
