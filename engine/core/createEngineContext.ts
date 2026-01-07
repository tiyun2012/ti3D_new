import type { EngineContext } from './EngineModule';
import { eventBus } from '@/engine/EventBus';

/**
 * Bridge context used by new feature modules.
 * Keeps legacy engineInstance intact while you migrate features incrementally.
 */
export function createEngineContext(): EngineContext {
  return {
    events: eventBus,
    commands: {},
  };
}
