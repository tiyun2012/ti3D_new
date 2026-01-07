# Refactor Notes

This refactor introduces a clearer top-level hierarchy:

- `app/` – React app entry (`app/App.tsx`)
- `editor/` – editor UI (components, state, hooks)
- `engine/` – runtime engine (previously `services/`)
- `features/` – future feature modules (commands/events/systems)
- `drafts/` – prototypes excluded from TypeScript via `tsconfig.json`

Key fixes:

- Removed circular dependency (`AssetManager` no longer imports `engineInstance`).
  Texture uploads now emit `TEXTURE_LOADED` and the engine defers uploads until `initGL()`.
- Added `engine/api/*` to start migrating UI away from direct engine imports.

Migration strategy:

1) Keep the app working as-is.
2) Gradually replace `engineInstance` calls in UI with `useEngineAPI()` commands.
3) Move each feature into `features/<name>/` when ready.
