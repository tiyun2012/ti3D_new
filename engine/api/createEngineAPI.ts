
import type { EngineAPI } from './EngineAPI';
import { eventBus } from '@/engine/EventBus';
import { engineInstance } from '@/engine/engine';
import type { SimulationMode, MeshComponentMode } from '@/types';

export function createEngineAPI(): EngineAPI {
  return {
    commands: {
      selection: {
        setSelected(ids: string[]) {
          engineInstance.setSelected(ids);
        },
        clear() {
          engineInstance.setSelected([]);
        },
      },
      simulation: {
        setMode(mode: SimulationMode) {
          engineInstance.simulationMode = mode;
          engineInstance.notifyUI();
        },
      },
      mesh: {
        setComponentMode(mode: MeshComponentMode) {
          engineInstance.meshComponentMode = mode;
          engineInstance.notifyUI();
        },
      },
    },

    subscribe(event: string, cb: (payload: any) => void) {
      eventBus.on(event, cb);
      return () => eventBus.off(event, cb);
    },

    getSelectedIds() {
      const indices = engineInstance.selectionSystem.selectedIndices;
      const ids: string[] = [];
      indices.forEach(idx => {
          const id = engineInstance.ecs.store.ids[idx];
          if (id) ids.push(id);
      });
      return ids;
    },
  };
}
