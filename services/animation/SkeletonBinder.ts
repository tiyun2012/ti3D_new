
import { SkeletalMeshAsset, AnimationClip } from '../../types';

interface BoundTrack {
    trackIndex: number; // Index in the clip.tracks array
    ecsIndex: number;   // Direct index in your SoA storage
    type: 'position' | 'rotation' | 'scale';
}

export class SkeletonBinder {
    // Cache: Map<MeshEntityID_ClipName, BoundTrack[]>
    private bindings = new Map<string, BoundTrack[]>();

    getBindings(
        meshEntityId: string, 
        clip: AnimationClip, 
        boneIds: string[], 
        ecs: any
    ): BoundTrack[] {
        // Create a unique key for this combination
        const key = `${meshEntityId}_${clip.name}`;
        
        if (this.bindings.has(key)) {
            return this.bindings.get(key)!;
        }

        // --- BINDING PROCESS (Run once per clip switch) ---
        const newBindings: BoundTrack[] = [];
        const boneMap = new Map<string, number>();

        // 1. Map Bone Names to ECS Indices
        boneIds.forEach(id => {
            const idx = ecs.idToIndex.get(id);
            if (idx !== undefined) {
                const name = ecs.store.names[idx]; // Assuming you store names
                if(name) boneMap.set(name, idx);
                
                // Fallback: Also map by sanitized name if your asset names differ
                const safeName = name.replace(':', '_').replace('.', '_');
                boneMap.set(safeName, idx);
            }
        });

        // 2. Link Tracks to ECS Indices
        clip.tracks.forEach((track, trackIdx) => {
            const ecsIdx = boneMap.get(track.name);
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

    clear(meshEntityId: string) {
        // Call this when entity is destroyed
        for (const key of this.bindings.keys()) {
            if (key.startsWith(meshEntityId)) {
                this.bindings.delete(key);
            }
        }
    }
}
