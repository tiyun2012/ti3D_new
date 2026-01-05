
import { RigPose } from './RigPose';
import { RigLayout } from './RigLayout';
import { engineInstance } from '../engine';
import { assetManager } from '../AssetManager';
import { ComponentType } from '../../types';

export class RigVisualizer {
    private _layout: RigLayout;
    // Map RigNode Index -> ECS Entity Index
    private _entityMap: Map<number, number> = new Map();
    private _bonePairs: {pIdx: number, cIdx: number}[] = [];

    constructor(layout: RigLayout) {
        this._layout = layout;
        this.buildStructure();
    }

    private buildStructure() {
        this._layout.nodes.forEach(node => {
            let assetId = '';
            // Map shapes to existing assets in AssetManager
            switch (node.type) {
                case 'Box': assetId = 'SM_Cube'; break;
                case 'Sphere': assetId = 'SM_Sphere'; break;
                case 'Bone': assetId = 'SM_Sphere'; break; // Use small sphere for joints
                case 'Circle': assetId = 'SM_Cylinder'; break; // Placeholder using Cylinder
            }

            if (assetId) {
                // Create Entity directly via ECS for speed/control
                const id = engineInstance.ecs.createEntity(node.name);
                const idx = engineInstance.ecs.idToIndex.get(id)!;
                
                engineInstance.ecs.addComponent(id, ComponentType.MESH);
                
                // Assign Mesh
                const meshId = assetManager.getMeshID(assetId);
                // Fallback to Cube if asset not found
                engineInstance.ecs.store.meshType[idx] = meshId > 0 ? meshId : 1; 
                
                // Color Handling
                if (node.color !== undefined) {
                    const r = ((node.color >> 16) & 255) / 255;
                    const g = ((node.color >> 8) & 255) / 255;
                    const b = (node.color & 255) / 255;
                    engineInstance.ecs.store.colorR[idx] = r;
                    engineInstance.ecs.store.colorG[idx] = g;
                    engineInstance.ecs.store.colorB[idx] = b;
                }

                // Scale based on node.size
                const s = node.size || 0.2;
                engineInstance.ecs.store.scaleX[idx] = s;
                engineInstance.ecs.store.scaleY[idx] = s;
                engineInstance.ecs.store.scaleZ[idx] = s;

                // Register with SceneGraph (though we manually control matrix, registration ensures cleanup/visibility)
                engineInstance.sceneGraph.registerEntity(id);
                
                this._entityMap.set(node.index, idx);
            }

            if (node.parentId !== -1) {
                this._bonePairs.push({ pIdx: node.parentId, cIdx: node.index });
            }
        });
    }

    public update(pose: RigPose) {
        const globals = pose.globalMatrices;
        const ecsWorld = engineInstance.ecs.store.worldMatrix;

        // A. Update Shapes
        this._entityMap.forEach((ecsIdx, rigIdx) => {
            const rigOffset = rigIdx * 16;
            const ecsOffset = ecsIdx * 16;
            
            // Bulk copy matrix (16 floats) from RigPose to ECS
            // This bypasses the scene graph hierarchy calculation for these specific nodes
            // which is exactly what we want for a visualizer controlled by a VM.
            for(let i=0; i<16; i++) {
                ecsWorld[ecsOffset + i] = globals[rigOffset + i];
            }
        });

        // B. Draw Bone Lines
        const debug = engineInstance.debugRenderer;
        if (debug) {
            this._bonePairs.forEach(pair => {
                const pOff = pair.pIdx * 16;
                const cOff = pair.cIdx * 16;
                
                const p1 = { x: globals[pOff+12], y: globals[pOff+13], z: globals[pOff+14] };
                const p2 = { x: globals[cOff+12], y: globals[cOff+13], z: globals[cOff+14] };
                
                debug.drawLine(p1, p2, { r: 1, g: 1, b: 0 }); // Yellow connection lines
            });
        }
    }
    
    public destroy() {
        // Cleanup entities
        this._entityMap.forEach((ecsIdx) => {
            const id = engineInstance.ecs.store.ids[ecsIdx];
            if (id) engineInstance.deleteEntity(id, engineInstance.sceneGraph);
        });
        this._entityMap.clear();
    }
}
