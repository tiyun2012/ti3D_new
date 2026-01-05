
import { RigVM, OpCode, RigInstruction } from '../rig/RigVM';
import { RigPose } from '../rig/RigPose';
import { assetManager } from '../AssetManager';
import { engineInstance } from '../engine';
import { Asset } from '../../types';

class RigInstance {
    vm: RigVM;
    entityMap: Map<string, number>; // EntityID -> RigPoseIndex
    
    constructor(vm: RigVM, entityMap: Map<string, number>) {
        this.vm = vm;
        this.entityMap = entityMap;
    }
}

export class ControlRigSystem {
    private instances = new Map<string, RigInstance>(); // EntityID (Root) -> RigInstance

    update(dt: number) {
        this.instances.forEach((instance, rootId) => {
            instance.vm.execute();
            instance.entityMap.forEach((poseIdx, entityId) => {
                const ecsIdx = engineInstance.ecs.idToIndex.get(entityId);
                if (ecsIdx !== undefined) {
                    const globals = instance.vm.pose.globalMatrices;
                    const offset = poseIdx * 16;
                    const ecsWorld = engineInstance.ecs.store.worldMatrix;
                    const ecsOffset = ecsIdx * 16;
                    for(let k=0; k<16; k++) ecsWorld[ecsOffset + k] = globals[offset + k];
                    engineInstance.sceneGraph.setDirty(entityId); 
                }
            });
        });
    }

    getOrCreateRigInstance(rootEntityId: string, rigAssetId: string): RigInstance | null {
        if (this.instances.has(rootEntityId)) return this.instances.get(rootEntityId)!;
        const asset = assetManager.getAsset(rigAssetId);
        if (!asset || asset.type !== 'RIG') return null;
        return null; // Compiler stub
    }
}

export const controlRigSystem = new ControlRigSystem();
