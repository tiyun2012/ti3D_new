
import { AnimationClip } from '../../types';

interface BoundTrack {
    trackIndex: number; // Index in the clip.tracks array
    ecsIndex: number;   // Direct index in ECS (SoA)
    type: 'position' | 'rotation' | 'scale';
}

export class SkeletonBinder {
    // Cache: Map<UniqueKey, BoundTrack[]>
    private bindings = new Map<string, BoundTrack[]>();

    /**
     * Returns a cached binding list for a specific entity and clip.
     * If not found, it computes it (Binding Phase).
     */
    getBindings(
        meshEntityId: string, 
        clip: AnimationClip, 
        boneIds: string[], 
        ecs: any
    ): BoundTrack[] {
        // Unique key for this Entity + Clip combination
        const key = `${meshEntityId}_${clip.name}`;
        
        if (this.bindings.has(key)) {
            return this.bindings.get(key)!;
        }

        // --- BINDING PHASE (Runs once) ---
        const newBindings: BoundTrack[] = [];
        const boneMap = new Map<string, number>();

        // 1. Map Bone Names to ECS Indices
        boneIds.forEach(id => {
            const idx = ecs.idToIndex.get(id);
            if (idx !== undefined) {
                // Try exact name
                const name = ecs.store.names[idx];
                if (name) boneMap.set(name, idx);
                
                // Try sanitized name (Mixamo often converts spaces to _)
                const safeName = name.replace(':', '_').replace('.', '_');
                boneMap.set(safeName, idx);
            }
        });

        // 2. Link Tracks to ECS Indices
        clip.tracks.forEach((track, trackIdx) => {
            const ecsIdx = boneMap.get(track.name);
            
            // Only bind if the target bone actually exists in this skeleton
            if (ecsIdx !== undefined) {
                newBindings.push({
                    trackIndex: trackIdx,
                    ecsIndex: ecsIdx,
                    type: track.type
                });
            }
        });

        this.bindings.set(key, newBindings);
        return newBindings;
    }

    /**
     * Call this when an entity is destroyed to free memory
     */
    clear(meshEntityId: string) {
        for (const key of this.bindings.keys()) {
            if (key.startsWith(meshEntityId)) {
                this.bindings.delete(key);
            }
        }
    }
}
