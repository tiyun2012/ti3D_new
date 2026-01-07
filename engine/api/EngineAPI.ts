import type { SimulationMode, MeshComponentMode } from '@/types';

export type EngineAPI = {
  // Commands: stable surface that UI should call
  commands: {
    selection: {
      setSelected(ids: string[]): void;
      clear(): void;
    };
    simulation: {
      setMode(mode: SimulationMode): void;
    };
    mesh: {
      setComponentMode(mode: MeshComponentMode): void;
    };
  };

  // Events: subscribe to engine/editor events
  subscribe(event: string, cb: (payload: any) => void): () => void;

  // Queries: read-only accessors for UI
  getSelectedIds(): string[];
};
