# ti3D Editor Refactor Template

This refactor is designed to make it easy to add new features with minimum impact on existing ones.

## High-level layers

- **app/**
  - App shell & bootstrapping.
- **editor/**
  - React UI: panels, layouts, editor state.
- **engine/**
  - Runtime engine/services (rendering, ECS, tools, physics...).
  - `engine/api/` = stable UI-facing API (commands/events/queries).
  - `engine/core/` = lightweight module pattern for new features.
- **features/**
  - Feature modules that can be plugged in without touching unrelated code.
- **drafts/**
  - WIP/experimental code excluded from TS typechecking.

## How to add a new feature

1. Create `features/<featureName>/` with:
   - events: `feature.events.ts` (strings only)
   - commands: `feature.commands.ts` (write-only operations)
   - types: `feature.types.ts`
   - module: `FeatureModule.ts` that registers commands/events into `EngineContext`.
2. Keep UI usage behind `engine/api/EngineAPI` (or a feature-specific API) so UI does not import engine singletons.

## Important decoupling rule

UI should not import engine singletons directly (e.g. `engineInstance`) for new code.
Use:
- `engine/api/createEngineAPI.ts`
- `engine/api/EngineProvider.tsx` + `useEngineAPI()`

Existing code still works and can be migrated incrementally.
