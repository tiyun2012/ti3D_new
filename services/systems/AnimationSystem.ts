
import { AnimationClip, SkeletalMeshAsset, AnimationTrack } from '../../types';
import { Mat4Utils, QuatUtils, Vec3Utils, MathUtils } from '../math';
import { assetManager } from '../AssetManager';

export class AnimationSystem {
    
    evaluateTrack(track: AnimationTrack, time: number): Float32Array {
        // Find keyframe
        const times = track.times;
        const values = track.values;
        
        // Binary search or linear scan
        let idx = 0;
        for (let i = 0; i < times.length - 1; i++) {
            if (time < times[i + 1]) {
                idx = i;
                break;
            }
        }
        
        const t1 = times[idx];
        const t2 = times[idx + 1] || t1;
        const factor = (time - t1) / (t2 - t1);
        const t = Math.max(0, Math.min(1, isNaN(factor) ? 0 : factor));
        
        const stride = track.type === 'rotation' ? 4 : 3;
        const start = idx * stride;
        const end = (idx + 1) * stride;
        
        if (track.type === 'rotation') {
            const q1 = { x: values[start], y: values[start+1], z: values[start+2], w: values[start+3] };
            const q2 = { x: values[end], y: values[end+1], z: values[end+2], w: values[end+3] };
            const qRes = { x: 0, y: 0, z: 0, w: 1 };
            QuatUtils.slerp(q1, q2, t, qRes);
            return new Float32Array([qRes.x, qRes.y, qRes.z, qRes.w]);
        } else {
            const v1 = { x: values[start], y: values[start+1], z: values[start+2] };
            const v2 = { x: values[end], y: values[end+1], z: values[end+2] };
            const vRes = { x: 0, y: 0, z: 0 };
            Vec3Utils.lerp(v1, v2, t, vRes);
            return new Float32Array([vRes.x, vRes.y, vRes.z]);
        }
    }

    update(dt: number, time: number, meshSystem: any, ecs: any, sceneGraph: any) {
        // Iterate entities with Mesh components that have Skeletal Assets
        const store = ecs.store;
        const debug = (window as any).engineInstance.debugRenderer;
        
        // Get currently selected bone index from MeshSystem to highlight it
        const selectedBoneIndex = meshSystem.selectedBoneIndex;

        for (let i = 0; i < ecs.count; i++) {
            if (!store.isActive[i]) continue;
            
            const meshIntId = store.meshType[i];
            const uuid = assetManager.meshIntToUuid.get(meshIntId);
            if (!uuid) continue;
            
            const asset = assetManager.getAsset(uuid);
            if (!asset || asset.type !== 'SKELETAL_MESH') continue;
            
            const skelAsset = asset as SkeletalMeshAsset;
            if (skelAsset.skeleton.bones.length === 0) continue;
            
            // Determine active clip
            const animIndex = store.animationIndex[i] || 0;
            const clip = skelAsset.animations[animIndex];
            
            // Calculate local time. If dt > 0 (playing), advance time. Else rely on passed 'time' or 0.
            const localTime = clip ? time % clip.duration : 0;
            
            // Compute Global Pose Matrices
            const boneMatrices = new Float32Array(skelAsset.skeleton.bones.length * 16);
            const globalMatrices = new Float32Array(skelAsset.skeleton.bones.length * 16);
            
            const entityId = store.ids[i];
            const entityWorld = sceneGraph.getWorldMatrix(entityId);

            skelAsset.skeleton.bones.forEach((bone, bIdx) => {
                const safeName = bone.name.replace(':', '_').replace('.', '_'); // Sanitize
                
                let m = Mat4Utils.create();

                if (clip) {
                    // Find tracks
                    // Optimization: Pre-map tracks to bones in AssetManager to avoid find() in loop
                    const posTrack = clip.tracks.find(t => t.name === safeName && t.type === 'position') || clip.tracks.find(t => t.name.includes(safeName) && t.type === 'position');
                    const rotTrack = clip.tracks.find(t => t.name === safeName && t.type === 'rotation') || clip.tracks.find(t => t.name.includes(safeName) && t.type === 'rotation');
                    const sclTrack = clip.tracks.find(t => t.name === safeName && t.type === 'scale') || clip.tracks.find(t => t.name.includes(safeName) && t.type === 'scale');
                    
                    const p = posTrack ? this.evaluateTrack(posTrack, localTime) : new Float32Array([0,0,0]);
                    const r = rotTrack ? this.evaluateTrack(rotTrack, localTime) : new Float32Array([0,0,0,1]);
                    const s = sclTrack ? this.evaluateTrack(sclTrack, localTime) : new Float32Array([1,1,1]);
                    
                    Mat4Utils.compose(
                        {x: p[0], y: p[1], z: p[2]},
                        {x: r[0], y: r[1], z: r[2], w: r[3]},
                        {x: s[0], y: s[1], z: s[2]},
                        m
                    );
                } else {
                    // Default to Bind Pose if no animation
                    // Use bind pose relative to parent
                    // Note: bone.bindPose is usually local transform in T-pose
                    Mat4Utils.copy(m, bone.bindPose);
                }
                
                const globalM = Mat4Utils.create();
                if (bone.parentIndex !== -1) {
                    const parentGlobal = globalMatrices.subarray(bone.parentIndex * 16, (bone.parentIndex + 1) * 16);
                    Mat4Utils.multiply(parentGlobal, m, globalM);
                } else {
                    Mat4Utils.copy(globalM, m);
                }
                
                globalMatrices.set(globalM, bIdx * 16);
                
                // Final Skinning Matrix = GlobalPose * InverseBindPose
                const offsetM = Mat4Utils.create();
                Mat4Utils.multiply(globalM, bone.inverseBindPose, offsetM);
                boneMatrices.set(offsetM, bIdx * 16);

                // --- DEBUG DRAW SKELETON ---
                // Only draw if we have a valid Debug Renderer and the entity is selected or we are in skinning mode
                if (debug && entityWorld) {
                    const isSelected = (window as any).engineInstance.selectedIndices.has(i);
                    const isSkinning = (window as any).engineInstance.meshComponentMode !== 'OBJECT';
                    
                    if (isSelected || isSkinning) {
                        const bPos = { x: globalM[12], y: globalM[13], z: globalM[14] };
                        const worldPos = Vec3Utils.transformMat4(bPos, entityWorld, {x:0,y:0,z:0});
                        
                        const isBoneSelected = bIdx === selectedBoneIndex;
                        const jointColor = isBoneSelected ? {r:1,g:0,b:1} : {r:1,g:1,b:0}; // Magenta vs Yellow
                        const jointSize = isBoneSelected ? 8 : 4;

                        // Draw Joint
                        debug.drawPoint(worldPos, jointColor, jointSize);

                        if (bone.parentIndex !== -1) {
                            const pMat = globalMatrices.subarray(bone.parentIndex * 16, (bone.parentIndex + 1) * 16);
                            const pPos = { x: pMat[12], y: pMat[13], z: pMat[14] };
                            const worldP = Vec3Utils.transformMat4(pPos, entityWorld, {x:0,y:0,z:0});
                            
                            // Bone Line
                            debug.drawLine(worldP, worldPos, isBoneSelected ? {r:1,g:0,b:1} : {r:1,g:1,b:0});
                        }
                    }
                }
            });
            
            // Upload to GPU
            meshSystem.uploadBoneMatrices(boneMatrices);
        }
    }
}
