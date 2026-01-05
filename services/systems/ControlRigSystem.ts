
import { RigVM, OpCode, RigInstruction } from '../rig/RigVM';
import { RigPose } from '../rig/RigPose';
import { RigLayout } from '../rig/RigLayout';
import { RigVisualizer } from '../rig/RigVisualizer';
import { assetManager } from '../AssetManager';
import { engineInstance } from '../engine';
import { Asset } from '../../types';
import { Mat4Utils } from '../math';

class RigInstance {
    vm: RigVM;
    entityMap: Map<string, number>; // EntityID -> RigPoseIndex
    visualizer?: RigVisualizer;
    
    constructor(vm: RigVM, entityMap: Map<string, number>, visualizer?: RigVisualizer) {
        this.vm = vm;
        this.entityMap = entityMap;
        this.visualizer = visualizer;
    }
}

export class ControlRigSystem {
    private instances = new Map<string, RigInstance>(); // EntityID (Root) -> RigInstance

    update(dt: number) {
        this.instances.forEach((instance, rootId) => {
            // 1. Sync Input from ECS (if needed) or User Interaction
            
            // 2. Execute VM
            instance.vm.execute();

            // 3. Sync Output to ECS (for driven entities)
            instance.entityMap.forEach((poseIdx, entityId) => {
                const ecsIdx = engineInstance.ecs.idToIndex.get(entityId);
                if (ecsIdx !== undefined) {
                    const globals = instance.vm.pose.globalMatrices;
                    const offset = poseIdx * 16;
                    const ecsWorld = engineInstance.ecs.store.worldMatrix;
                    const ecsOffset = ecsIdx * 16;
                    
                    for(let k=0; k<16; k++) {
                        ecsWorld[ecsOffset + k] = globals[offset + k];
                    }
                    
                    // Note: If we drive transforms directly, we might need to handle dirty flags
                    // if children rely on SceneGraph propagation.
                    engineInstance.sceneGraph.setDirty(entityId); 
                }
            });

            // 4. Update Visualizer
            if (instance.visualizer) {
                instance.visualizer.update(instance.vm.pose);
            }
        });
    }

    getOrCreateRigInstance(rootEntityId: string, rigAssetId: string): RigInstance | null {
        if (this.instances.has(rootEntityId)) return this.instances.get(rootEntityId)!;

        const asset = assetManager.getAsset(rigAssetId);
        // if (!asset || asset.type !== 'RIG') return null; // Relaxed for testing

        // --- STUB: Manually construct a test rig if no real graph compiler exists ---
        // This mirrors the "Hierarchy Test Code" from the request to verify logic
        
        const NODE_COUNT = 3;
        const pose = new RigPose(NODE_COUNT);
        const constants = new Float32Array(16 * NODE_COUNT);
        
        // Define Offsets (Home Matrices)
        const idMat = Mat4Utils.create(); // Identity
        const offsetMat = Mat4Utils.create(); // Offset Y=2.0
        Mat4Utils.fromTranslation({x:0, y:2.0, z:0}, offsetMat);
        
        // 0: Root (0,0,0)
        constants.set(idMat, 0); 
        // 1: Hip_Control (Offset 2.0 up)
        constants.set(offsetMat, 16); 
        // 2: Spine (0,0,0 local to Hip)
        constants.set(idMat, 32);

        const program: RigInstruction[] = [
            // Root
            { op: OpCode.CALC_OFFSET, target: 0, srcA: -1, param: 0 },
            // Hip (Child of Root)
            { op: OpCode.CALC_OFFSET, target: 1, srcA: -1, param: 1 },
            { op: OpCode.CALC_GLOBAL, target: 1, srcA: 0 },
            // Spine (Child of Hip)
            { op: OpCode.CALC_OFFSET, target: 2, srcA: 1, param: 2 },
            { op: OpCode.CALC_GLOBAL, target: 2, srcA: 1 }
        ];

        const vm = new RigVM(pose, program, constants);

        // --- VISUALIZER SETUP ---
        const layout = new RigLayout();
        layout.addNode({ index: 0, name: "Root", parentId: -1, type: "Bone", size: 0.3, color: 0xff0000 });
        layout.addNode({ index: 1, name: "Hip_Control", parentId: 0, type: "Box", size: 0.5, color: 0x00ff00 });
        layout.addNode({ index: 2, name: "Spine_01", parentId: 1, type: "Bone", size: 0.2, color: 0x0000ff });

        const visualizer = new RigVisualizer(layout);
        const entityMap = new Map<string, number>();

        const instance = new RigInstance(vm, entityMap, visualizer);
        this.instances.set(rootEntityId, instance);
        
        return instance;
    }
}

export const controlRigSystem = new ControlRigSystem();
