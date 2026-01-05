
import { SkeletalMeshAsset } from '../../types';
import { Mat4Utils, QuatUtils } from '../math';
import { assetManager } from '../AssetManager';
import { DebugRenderer } from '../renderers/DebugRenderer';
import { AnimationEvaluator } from '../animation/AnimationEvaluator';
import { SkeletonBinder } from '../animation/SkeletonBinder';

export class AnimationSystem {
    private binder = new SkeletonBinder();

    update(dt: number, time: number, isPlaying: boolean, skeletonMap: Map<string, string[]>, meshSystem: any, ecs: any, sceneGraph: any, debugRenderer?: DebugRenderer, selectedIndices?: Set<number>, meshComponentMode?: string) {
        const store = ecs.store;

        for (let i = 0; i < ecs.count; i++) {
            if (!store.isActive[i]) continue;
            
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

            const animIndex = store.animationIndex[i] || 0;
            const clip = skelAsset.animations[animIndex];
            
            if (isPlaying && clip) {
                const localTime = time % clip.duration;
                const bindings = this.binder.getBindings(entityId, clip, boneIds, ecs);

                for (let k = 0; k < bindings.length; k++) {
                    const bind = bindings[k];
                    const track = clip.tracks[bind.trackIndex];
                    const value = AnimationEvaluator.evaluateTrack(track, localTime);
                    
                    if (bind.type === 'position') {
                        ecs.store.setPosition(bind.ecsIndex, value[0], value[1], value[2]);
                    } else if (bind.type === 'rotation') {
                        const q = { x: value[0], y: value[1], z: value[2], w: value[3] };
                        const euler = QuatUtils.toEuler(q, { x: 0, y: 0, z: 0 });
                        ecs.store.setRotation(bind.ecsIndex, euler.x, euler.y, euler.z);
                    } else if (bind.type === 'scale') {
                        ecs.store.setScale(bind.ecsIndex, value[0], value[1], value[2]);
                    }
                    sceneGraph.setDirty(store.ids[bind.ecsIndex]);
                }
            }
            this.updateSkinMatrices(skelAsset, boneIds, sceneGraph, meshSystem, debugRenderer, ecs, selectedIndices, meshComponentMode);
        }
    }

    private updateSkinMatrices(
        asset: SkeletalMeshAsset, 
        boneIds: string[], 
        sceneGraph: any, 
        meshSystem: any,
        debugRenderer: DebugRenderer | undefined,
        ecs: any,
        selectedIndices?: Set<number>,
        meshComponentMode?: string
    ) {
        const boneMatrices = new Float32Array(asset.skeleton.bones.length * 16);
        
        asset.skeleton.bones.forEach((bone, bIdx) => {
            const boneEntityId = boneIds[bIdx];
            if (!boneEntityId) return;

            const worldMat = sceneGraph.getWorldMatrix(boneEntityId);
            if (worldMat) {
                const skinM = Mat4Utils.create();
                Mat4Utils.multiply(worldMat, bone.inverseBindPose, skinM);
                boneMatrices.set(skinM, bIdx * 16);

                if (debugRenderer && selectedIndices) {
                    const bPos = { x: worldMat[12], y: worldMat[13], z: worldMat[14] };
                    const idx = ecs.idToIndex.get(boneEntityId);
                    const isBoneSelected = idx !== undefined && selectedIndices.has(idx);
                    
                    if (isBoneSelected || meshComponentMode !== 'OBJECT') {
                         debugRenderer.drawPoint(bPos, isBoneSelected ? {r:1,g:0,b:1} : {r:1,g:1,b:0}, isBoneSelected?8:4);
                         if (bone.parentIndex !== -1) {
                             const pId = boneIds[bone.parentIndex];
                             const pMat = sceneGraph.getWorldMatrix(pId);
                             if (pMat) {
                                 const pPos = { x: pMat[12], y: pMat[13], z: pMat[14] };
                                 debugRenderer.drawLine(pPos, bPos, {r:1,g:1,b:0});
                             }
                         }
                    }
                }
            }
        });
        meshSystem.uploadBoneMatrices(boneMatrices);
    }
}
