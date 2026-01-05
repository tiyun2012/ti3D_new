
import { SkeletalMeshAsset } from '../../types';
import { Mat4Utils, QuatUtils } from '../math';
import { assetManager } from '../AssetManager';
import { DebugRenderer } from '../renderers/DebugRenderer';
import { AnimationEvaluator } from '../animation/AnimationEvaluator';
import { SkeletonBinder } from '../animation/SkeletonBinder';

export class AnimationSystem {
    private binder = new SkeletonBinder();

    update(
        dt: number, 
        time: number, 
        isPlaying: boolean,
        skeletonMap: Map<string, string[]>,
        meshSystem: any, 
        ecs: any, 
        sceneGraph: any, 
        debugRenderer?: DebugRenderer, 
        selectedIndices?: Set<number>, 
        meshComponentMode?: string
    ) {
        const store = ecs.store;

        for (let i = 0; i < ecs.count; i++) {
            if (!store.isActive[i]) continue;
            
            // 1. Validation & Asset Retrieval
            const meshIntId = store.meshType[i];
            const uuid = assetManager.meshIntToUuid.get(meshIntId);
            if (!uuid) continue;
            
            const asset = assetManager.getAsset(uuid);
            if (!asset || asset.type !== 'SKELETAL_MESH') continue;
            
            const skelAsset = asset as SkeletalMeshAsset;
            if (skelAsset.skeleton.bones.length === 0) continue;
            
            const entityId = store.ids[i];
            const boneIds = skeletonMap.get(entityId);
            if (!boneIds) continue; 

            // 2. Animation Logic
            const animIndex = store.animationIndex[i] || 0;
            const clip = skelAsset.animations[animIndex];
            
            if (isPlaying && clip) {
                const localTime = time % clip.duration;
                
                // Get Cached Bindings (O(1) after first frame)
                const bindings = this.binder.getBindings(entityId, clip, boneIds, ecs);

                // Batch Process Tracks
                for(let k=0; k<bindings.length; k++) {
                    const bind = bindings[k];
                    const track = clip.tracks[bind.trackIndex];
                    const value = AnimationEvaluator.evaluateTrack(track, localTime);
                    
                    // Direct SoA access
                    if (bind.type === 'position') {
                        ecs.store.setPosition(bind.ecsIndex, value[0], value[1], value[2]);
                    } else if (bind.type === 'rotation') {
                        const q = { x: value[0], y: value[1], z: value[2], w: value[3] };
                        const euler = QuatUtils.toEuler(q, { x: 0, y: 0, z: 0 });
                        ecs.store.setRotation(bind.ecsIndex, euler.x, euler.y, euler.z);
                    } else if (bind.type === 'scale') {
                        ecs.store.setScale(bind.ecsIndex, value[0], value[1], value[2]);
                    }
                    
                    sceneGraph.setDirty(store.ids[bind.ecsIndex]); // Notify SceneGraph
                }
            }

            // 3. Skinning & Debugging (Always run, even if paused, to handle manual bone moves)
            this.updateSkinMatrices(skelAsset, boneIds, sceneGraph, meshSystem, ecs, debugRenderer, selectedIndices, meshComponentMode);
        }
    }

    private updateSkinMatrices(
        asset: SkeletalMeshAsset, 
        boneIds: string[], 
        sceneGraph: any, 
        meshSystem: any, 
        ecs: any,
        debugRenderer?: DebugRenderer, 
        selectedIndices?: Set<number>, 
        meshComponentMode?: string
    ) {
        const boneMatrices = new Float32Array(asset.skeleton.bones.length * 16);
        
        asset.skeleton.bones.forEach((bone, bIdx) => {
            const boneEntityId = boneIds[bIdx];
            if (!boneEntityId) return;

            const worldMat = sceneGraph.getWorldMatrix(boneEntityId);
            if (worldMat) {
                // Calculate Skin Matrix: World * InverseBindPose
                const skinM = Mat4Utils.create();
                Mat4Utils.multiply(worldMat, bone.inverseBindPose, skinM);
                boneMatrices.set(skinM, bIdx * 16);

                // Debug Draw
                if (debugRenderer) {
                    this.drawDebugBone(boneEntityId, worldMat, bone.parentIndex, boneIds, sceneGraph, debugRenderer, ecs, selectedIndices, meshComponentMode);
                }
            }
        });

        meshSystem.uploadBoneMatrices(boneMatrices);
    }

    private drawDebugBone(
        entityId: string, 
        worldMat: Float32Array, 
        parentIndex: number, 
        boneIds: string[], 
        sceneGraph: any,
        debugRenderer: DebugRenderer,
        ecs: any,
        selectedIndices?: Set<number>, 
        mode?: string
    ) {
        if (!selectedIndices) return;
        
        const bPos = { x: worldMat[12], y: worldMat[13], z: worldMat[14] };
        const idx = ecs.idToIndex.get(entityId);
        const isBoneSelected = selectedIndices.has(idx);
        
        if (isBoneSelected || mode !== 'OBJECT') {
             debugRenderer.drawPoint(bPos, isBoneSelected ? {r:1,g:0,b:1} : {r:1,g:1,b:0}, isBoneSelected ? 8 : 4);
             
             if (parentIndex !== -1) {
                 const pId = boneIds[parentIndex];
                 const pMat = sceneGraph.getWorldMatrix(pId);
                 if (pMat) {
                     const pPos = { x: pMat[12], y: pMat[13], z: pMat[14] };
                     debugRenderer.drawLine(pPos, bPos, {r:1,g:1,b:0});
                 }
             }
        }
    }
}
