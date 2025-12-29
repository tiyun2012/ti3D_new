// services/engine.ts

import { SoAEntitySystem } from './ecs/EntitySystem';
import { SceneGraph } from './SceneGraph';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { HistorySystem } from './systems/HistorySystem';
import { WebGLRenderer, PostProcessConfig } from './renderers/WebGLRenderer';
import { DebugRenderer } from './renderers/DebugRenderer';
import { assetManager } from './AssetManager';
import { PerformanceMetrics, GraphNode, GraphConnection, ComponentType, TimelineState, MeshComponentMode, StaticMeshAsset, Asset, SimulationMode, Vector3, SoftSelectionFalloff, SkeletalMeshAsset } from '../types';
import { Mat4Utils, RayUtils, Vec3Utils, Ray, MathUtils } from './math';
import { compileShader } from './ShaderCompiler';
import { GridConfiguration, UIConfiguration, DEFAULT_UI_CONFIG } from '../contexts/EditorContext';
import { NodeRegistry } from './NodeRegistry';
import { MeshTopologyUtils, MeshPickingResult } from './MeshTopologyUtils';
import { gizmoSystem } from './GizmoSystem';
import { moduleManager } from './ModuleManager';
import { registerCoreModules } from './modules/CoreModules';
import { consoleService } from './Console';
import type { MeshRenderSystem } from './systems/MeshRenderSystem';
import { AnimationSystem } from './systems/AnimationSystem';

export type SoftSelectionMode = 'DYNAMIC' | 'FIXED';

export class Engine {
    ecs: SoAEntitySystem;
    sceneGraph: SceneGraph;
    physicsSystem: PhysicsSystem;
    historySystem: HistorySystem;
    animationSystem: AnimationSystem;
    renderer: WebGLRenderer;
    debugRenderer: DebugRenderer;
    metrics: PerformanceMetrics;
    isPlaying: boolean = false;
    simulationMode: SimulationMode = 'STOPPED';
    renderMode: number = 0;
    
    meshComponentMode: MeshComponentMode = 'OBJECT';
    subSelection = {
        vertexIds: new Set<number>(),
        edgeIds: new Set<string>(), 
        faceIds: new Set<number>()
    };
    
    hoveredVertex: { entityId: string, index: number } | null = null;
    isInputDown: boolean = false;

    // Soft Selection State
    softSelectionEnabled: boolean = false;
    softSelectionRadius: number = 2.0;
    softSelectionMode: SoftSelectionMode = 'FIXED';
    softSelectionFalloff: SoftSelectionFalloff = 'VOLUME'; 
    softSelectionHeatmapVisible: boolean = true;
    
    // Skinning State
    selectedBoneIndex: number = -1;
    
    // Cached weights for the current selection
    softSelectionWeights: Map<number, Float32Array> = new Map();

    // --- DEFORMATION SNAPSHOT STATE ---
    private vertexSnapshot: Float32Array | null = null;
    private currentDeformationDelta: Vector3 = { x: 0, y: 0, z: 0 };
    private activeDeformationEntity: string | null = null;

    uiConfig: UIConfiguration = DEFAULT_UI_CONFIG;

    timeline: TimelineState = {
        currentTime: 0,
        duration: 30,
        isPlaying: false,
        playbackSpeed: 1.0,
        isLooping: true
    };

    selectedIndices: Set<number> = new Set();
    private listeners: (() => void)[] = [];
    currentShaderSource: string = '';
    public currentViewProj: Float32Array | null = null;
    public currentCameraPos = { x: 0, y: 0, z: 0 };
    public currentWidth: number = 0;
    public currentHeight: number = 0;

    private accumulator: number = 0;
    private readonly fixedTimeStep: number = 1 / 60; 
    private readonly maxFrameTime: number = 0.1;     

    constructor() {
        this.ecs = new SoAEntitySystem();
        this.sceneGraph = new SceneGraph();
        this.sceneGraph.setContext(this.ecs);
        this.physicsSystem = new PhysicsSystem();
        this.historySystem = new HistorySystem();
        this.animationSystem = new AnimationSystem();
        this.renderer = new WebGLRenderer();
        this.debugRenderer = new DebugRenderer();
        this.metrics = { fps: 0, frameTime: 0, drawCalls: 0, triangleCount: 0, entityCount: 0 };
        
        registerCoreModules();
        moduleManager.init({
            engine: this,
            ecs: this.ecs,
            scene: this.sceneGraph
        });
    }

    get meshSystem(): MeshRenderSystem {
        return this.renderer.meshSystem;
    }

    initGL(canvas: HTMLCanvasElement) {
        this.renderer.init(canvas);
        this.renderer.initGizmo();
        this.debugRenderer.init(this.renderer.gl!);
        this.recompileAllMaterials();
        if (this.ecs.count === 0) this.createDefaultScene();
    }

    recompileAllMaterials() {
        assetManager.getAssetsByType('MATERIAL').forEach(asset => {
            if (asset.type === 'MATERIAL') this.compileGraph(asset.data.nodes, asset.data.connections, asset.id);
        });
    }

    private createDefaultScene() {
        const standardMat = assetManager.getAssetsByType('MATERIAL').find(a => a.name === 'Standard');
        const cubeId = this.createEntityFromAsset('SM_Cube', { x: -1.5, y: 0, z: 0 });
        const sphereId = this.createEntityFromAsset('SM_Sphere', { x: 1.5, y: 0, z: 0 });
        if (standardMat) {
            const cIdx = this.ecs.idToIndex.get(cubeId!);
            const sIdx = this.ecs.idToIndex.get(sphereId!);
            const mIntId = assetManager.getMaterialID(standardMat.id);
            if (cIdx !== undefined) this.ecs.store.materialIndex[cIdx] = mIntId;
            if (sIdx !== undefined) this.ecs.store.materialIndex[sIdx] = mIntId;
        }
        const light = this.ecs.createEntity('Directional Light');
        this.ecs.addComponent(light, ComponentType.LIGHT);
        const idx = this.ecs.idToIndex.get(light)!;
        this.ecs.store.setPosition(idx, 5, 10, 5);
        this.ecs.store.setRotation(idx, -0.785, 0.785, 0); 
        this.sceneGraph.registerEntity(light);
        this.createVirtualPivot();
    }

    resize(width: number, height: number) { this.renderer.resize(width, height); }
    
    start(mode: SimulationMode = 'GAME') { 
        this.isPlaying = true; 
        this.simulationMode = mode;
        this.timeline.isPlaying = true; 
        this.notifyUI(); 
        consoleService.info(mode === 'GAME' ? 'Game Started' : 'Simulation Started'); 
    }
    
    pause() { 
        this.timeline.isPlaying = false; 
        this.notifyUI(); 
        consoleService.info('Paused'); 
    }
    
    stop() { 
        this.isPlaying = false; 
        this.simulationMode = 'STOPPED';
        this.timeline.isPlaying = false; 
        this.timeline.currentTime = 0; 
        this.notifyUI(); 
        consoleService.info('Stopped'); 
    }
    
    setTimelineTime(time: number) { this.timeline.currentTime = Math.max(0, Math.min(time, this.timeline.duration)); this.notifyUI(); }

    createVirtualPivot(name: string = 'Virtual Pivot') {
        const id = this.ecs.createEntity(name);
        this.ecs.addComponent(id, ComponentType.VIRTUAL_PIVOT);
        this.sceneGraph.registerEntity(id);
        this.pushUndoState();
        this.notifyUI();
        consoleService.info(`Created helper: ${name}`);
        return id;
    }

    updateVertexColor(entityId: string, vertexIndex: number, color: {r: number, g: number, b: number}) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset || !asset.geometry.colors) return;
        
        asset.geometry.colors[vertexIndex * 3] = color.r;
        asset.geometry.colors[vertexIndex * 3 + 1] = color.g;
        asset.geometry.colors[vertexIndex * 3 + 2] = color.b;
        
        this.registerAssetWithGPU(asset);
    }

    // --- SKIN WEIGHT PAINTING ---
    paintSkinWeights(entityId: string, boneIndex: number, weight: number, mode: 'ADD'|'REPLACE'|'SMOOTH'|'REMOVE') {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as SkeletalMeshAsset;
        
        if (!asset || asset.type !== 'SKELETAL_MESH') return;
        
        const indices = asset.geometry.jointIndices;
        const weights = asset.geometry.jointWeights;
        
        // Vertices affected by brush (Soft Selection)
        const activeVerts = this.getSelectionAsVertices();
        // If soft selection is active, use its weights to attenuate brush
        const softWeights = this.softSelectionWeights.get(meshIntId);
        
        const selectionArray = Array.from(activeVerts);
        const brushVerts = this.softSelectionEnabled ? Array.from(softWeights?.keys() || []) : selectionArray;
        
        const loopCount = this.softSelectionEnabled && softWeights ? softWeights.length : selectionArray.length;

        for(let i=0; i<loopCount; i++) {
            const vIdx = this.softSelectionEnabled ? i : selectionArray[i];
            const influence = this.softSelectionEnabled && softWeights ? softWeights[i] : 1.0;
            
            if (influence <= 0.001) continue;

            const base = vIdx * 4;
            // Current weights for this vertex
            let w = [weights[base], weights[base+1], weights[base+2], weights[base+3]];
            let id = [indices[base], indices[base+1], indices[base+2], indices[base+3]];
            
            // Find slot for target bone
            let slot = -1;
            for(let k=0; k<4; k++) if(id[k] === boneIndex) slot = k;
            
            if (slot === -1) {
                // Find empty or smallest
                let minW = 2.0; let best = 0;
                for(let k=0; k<4; k++) {
                    if (w[k] < minW) { minW = w[k]; best = k; }
                }
                slot = best;
                id[slot] = boneIndex;
                w[slot] = 0;
            }

            const effectiveWeight = weight * influence;
            
            if (mode === 'REPLACE') {
                w[slot] = effectiveWeight;
            } else if (mode === 'ADD') {
                w[slot] = Math.min(1.0, w[slot] + effectiveWeight);
            } else if (mode === 'REMOVE') {
                w[slot] = Math.max(0.0, w[slot] - effectiveWeight);
            }

            // Normalize
            let sum = 0;
            for(let k=0; k<4; k++) sum += w[k];
            if (sum > 0) {
                const scale = 1.0 / sum;
                for(let k=0; k<4; k++) w[k] *= scale;
            }

            // Write back
            for(let k=0; k<4; k++) {
                indices[base+k] = id[k];
                weights[base+k] = w[k];
            }
        }
        
        this.registerAssetWithGPU(asset);
    }

    // --- SELECTION HELPERS ---
    
    getSelectionAsVertices(): Set<number> {
        if (this.selectedIndices.size === 0) return new Set();
        const idx = Array.from(this.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return new Set();
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return new Set();

        const result = new Set<number>();

        if (this.meshComponentMode === 'VERTEX') {
            return this.subSelection.vertexIds;
        }
        if (this.meshComponentMode === 'EDGE') {
            this.subSelection.edgeIds.forEach(key => {
                const [vA, vB] = key.split('-').map(Number);
                result.add(vA); result.add(vB);
            });
        }
        if (this.meshComponentMode === 'FACE') {
            const topo = asset.topology;
            if (topo) {
                this.subSelection.faceIds.forEach(fIdx => {
                    topo.faces[fIdx].forEach(v => result.add(v));
                });
            } else {
                // Fallback for non-topo meshes (raw tris)
                const indices = asset.geometry.indices;
                this.subSelection.faceIds.forEach(fIdx => {
                    // Assuming faces map to triangles directly if no topo
                    result.add(indices[fIdx * 3]);
                    result.add(indices[fIdx * 3 + 1]);
                    result.add(indices[fIdx * 3 + 2]);
                });
            }
        }
        return result;
    }

    // --- MARQUEE COMPONENT SELECTION ---
    selectComponentsInRect(rectX: number, rectY: number, rectW: number, rectH: number, mode: MeshComponentMode, append: boolean) {
        if (!this.currentViewProj || this.selectedIndices.size === 0) return;

        if (!append) {
            this.subSelection.vertexIds.clear();
            this.subSelection.edgeIds.clear();
            this.subSelection.faceIds.clear();
        }

        // Bounds
        const rLeft = rectX;
        const rRight = rectX + rectW;
        const rTop = rectY;
        const rBottom = rectY + rectH;
        
        const width = this.currentWidth;
        const height = this.currentHeight;
        const halfW = width * 0.5;
        const halfH = height * 0.5;

        const vp = this.currentViewProj;
        const mvp = new Float32Array(16);

        // Iterate selected entities (Usually just one for component editing)
        for (const idx of this.selectedIndices) {
            const entityId = this.ecs.store.ids[idx];
            const meshIntId = this.ecs.store.meshType[idx];
            const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
            if (!assetUuid) continue;
            const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
            if (!asset) continue;

            const worldMat = this.sceneGraph.getWorldMatrix(entityId);
            if (!worldMat) continue;

            // MVP = VP * Model
            Mat4Utils.multiply(vp, worldMat, mvp);
            
            const verts = asset.geometry.vertices;
            const vertexCount = verts.length / 3;

            // Access matrix elements directly for speed
            const m00 = mvp[0], m01 = mvp[1], m02 = mvp[2], m03 = mvp[3];
            const m10 = mvp[4], m11 = mvp[5], m12 = mvp[6], m13 = mvp[7];
            const m20 = mvp[8], m21 = mvp[9], m22 = mvp[10], m23 = mvp[11];
            const m30 = mvp[12], m31 = mvp[13], m32 = mvp[14], m33 = mvp[15];

            // Helper to check a 3D point (local space) vs screen rect
            const checkPoint = (lx: number, ly: number, lz: number) => {
                // Manual Matrix Multiply (Position * MVP)
                const w = m03*lx + m13*ly + m23*lz + m33;
                if (w <= 0) return false; // Behind camera plane
                
                const x = (m00*lx + m10*ly + m20*lz + m30) / w;
                const y = (m01*lx + m11*ly + m21*lz + m31) / w;
                
                // NDC (-1..1) to Screen Coords
                const sx = (x + 1) * halfW;
                const sy = (1 - y) * halfH; // Invert Y for screen coords
                
                return sx >= rLeft && sx <= rRight && sy >= rTop && sy <= rBottom;
            };

            if (mode === 'VERTEX') {
                for (let i = 0; i < vertexCount; i++) {
                    const lx = verts[i*3];
                    const ly = verts[i*3+1];
                    const lz = verts[i*3+2];
                    
                    if (checkPoint(lx, ly, lz)) {
                        this.subSelection.vertexIds.add(i);
                    }
                }
            } else if (mode === 'FACE') {
                // Check Face Centroids
                if (asset.topology) {
                    asset.topology.faces.forEach((face, fIdx) => {
                        let cx=0, cy=0, cz=0;
                        for(let vIdx of face) {
                            cx += verts[vIdx*3]; cy += verts[vIdx*3+1]; cz += verts[vIdx*3+2];
                        }
                        const inv = 1.0 / face.length;
                        if (checkPoint(cx*inv, cy*inv, cz*inv)) {
                            this.subSelection.faceIds.add(fIdx);
                        }
                    });
                } else {
                    // Triangle soup fallback
                    const idxs = asset.geometry.indices;
                    for (let i=0; i<idxs.length; i+=3) {
                        const i1=idxs[i], i2=idxs[i+1], i3=idxs[i+2];
                        const cx = (verts[i1*3]+verts[i2*3]+verts[i3*3])/3;
                        const cy = (verts[i1*3+1]+verts[i2*3+1]+verts[i3*3+1])/3;
                        const cz = (verts[i1*3+2]+verts[i2*3+2]+verts[i3*3+2])/3;
                        if (checkPoint(cx, cy, cz)) {
                            this.subSelection.faceIds.add(i/3);
                        }
                    }
                }
            } else if (mode === 'EDGE') {
                // Check Edge Midpoints
                if (asset.topology && asset.topology.graph) {
                    asset.topology.graph.halfEdges.forEach(he => {
                        // Prevent duplicates: only process one direction of the half-edge pair
                        if (he.pair !== -1 && he.id > he.pair) return;
                        
                        // Edge connects pair-vertex to this-vertex
                        const vDest = he.vertex;
                        const vOrigin = asset.topology!.graph!.halfEdges[he.prev].vertex;
                        
                        const lx = (verts[vDest*3] + verts[vOrigin*3]) * 0.5;
                        const ly = (verts[vDest*3+1] + verts[vOrigin*3+1]) * 0.5;
                        const lz = (verts[vDest*3+2] + verts[vOrigin*3+2]) * 0.5;
                        
                        if (checkPoint(lx, ly, lz)) {
                            const key = [vOrigin, vDest].sort((a,b)=>a-b).join('-');
                            this.subSelection.edgeIds.add(key);
                        }
                    });
                }
            }
        }
        
        this.recalculateSoftSelection();
        this.notifyUI();
    }

    recalculateSoftSelection(triggerDeformation = true) {
        if (!this.softSelectionEnabled || this.meshComponentMode === 'OBJECT') {
            this.softSelectionWeights.forEach((weights, meshId) => {
                weights.fill(0);
                this.meshSystem.updateSoftSelectionBuffer(meshId, weights);
            });
            this.softSelectionWeights.clear();
            return;
        }

        if (this.selectedIndices.size === 0) return;
        const idx = Array.from(this.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return;

        const useSnapshot = this.softSelectionMode === 'FIXED' && this.vertexSnapshot;
        const sourceVerts = useSnapshot ? this.vertexSnapshot! : asset.geometry.vertices;
        const vertexCount = sourceVerts.length / 3;
        
        const sx = this.ecs.store.scaleX[idx];
        const sy = this.ecs.store.scaleY[idx];
        const sz = this.ecs.store.scaleZ[idx];
        const maxScale = Math.max(sx, Math.max(sy, sz)) || 1.0;
        const localRadius = this.softSelectionRadius / maxScale;

        // Get unified vertex set from active mode (Edge/Face/Vertex)
        const selectedVerts = this.getSelectionAsVertices();
        let weights: Float32Array;

        if (this.softSelectionFalloff === 'SURFACE') {
            weights = MeshTopologyUtils.computeSurfaceWeights(
                asset.geometry.indices,
                sourceVerts,
                selectedVerts,
                localRadius,
                vertexCount
            );
        } else {
            weights = this.softSelectionWeights.get(meshIntId) || new Float32Array(vertexCount);
            
            const centroid = {x:0, y:0, z:0};
            const selection = Array.from(selectedVerts);
            
            if (selection.length > 0) {
                for(const vid of selection) {
                    centroid.x += sourceVerts[vid*3];
                    centroid.y += sourceVerts[vid*3+1];
                    centroid.z += sourceVerts[vid*3+2];
                }
                const invLen = 1.0 / selection.length;
                centroid.x *= invLen; centroid.y *= invLen; centroid.z *= invLen;

                for (let i = 0; i < vertexCount; i++) {
                    if (selectedVerts.has(i)) {
                        weights[i] = 1.0;
                        continue;
                    }
                    const vx = sourceVerts[i*3], vy = sourceVerts[i*3+1], vz = sourceVerts[i*3+2];
                    const dist = Math.sqrt((vx-centroid.x)**2 + (vy-centroid.y)**2 + (vz-centroid.z)**2);
                    
                    if (dist <= localRadius) {
                        const t = 1.0 - (dist / localRadius);
                        weights[i] = t * t * (3 - 2 * t); 
                    } else {
                        weights[i] = 0.0;
                    }
                }
            } else {
                weights.fill(0);
            }
        }

        this.softSelectionWeights.set(meshIntId, weights);
        this.meshSystem.updateSoftSelectionBuffer(meshIntId, weights);

        if (triggerDeformation && this.vertexSnapshot && this.activeDeformationEntity && this.softSelectionMode === 'FIXED') {
            this.applyDeformation(this.activeDeformationEntity);
        }
    }

    startVertexDrag(entityId: string) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return;

        this.vertexSnapshot = new Float32Array(asset.geometry.vertices);
        this.activeDeformationEntity = entityId;
        this.currentDeformationDelta = { x:0, y:0, z:0 };

        this.recalculateSoftSelection(false); 
    }

    updateVertexDrag(entityId: string, totalWorldDelta: Vector3) {
        if (!this.vertexSnapshot || this.activeDeformationEntity !== entityId) {
            this.startVertexDrag(entityId); 
        }

        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return;
        const invWorld = Mat4Utils.create();
        Mat4Utils.invert(worldMat, invWorld);
        
        const localTotalDelta = Vec3Utils.transformMat4Normal(totalWorldDelta, invWorld, {x:0,y:0,z:0});
        
        if (this.softSelectionEnabled && this.softSelectionMode === 'DYNAMIC') {
            const frameDelta = Vec3Utils.subtract(localTotalDelta, this.currentDeformationDelta, {x:0,y:0,z:0});
            this.applyIncrementalDeformation(entityId, frameDelta);
            this.recalculateSoftSelection(false); 
        } else {
            this.currentDeformationDelta = localTotalDelta;
            this.applyDeformation(entityId);
        }
        
        this.currentDeformationDelta = localTotalDelta;
    }

    private applyIncrementalDeformation(entityId: string, localDelta: Vector3) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset) return;

        const verts = asset.geometry.vertices;
        const weights = this.softSelectionWeights.get(meshIntId);
        
        // Use getSelectionAsVertices to support all modes
        const selectedVerts = this.getSelectionAsVertices();

        if (this.softSelectionEnabled && weights) {
            for (let i = 0; i < weights.length; i++) {
                const w = weights[i];
                if (w > 0.0001) {
                    verts[i*3] += localDelta.x * w;
                    verts[i*3+1] += localDelta.y * w;
                    verts[i*3+2] += localDelta.z * w;
                }
            }
        } else {
            for (const vIdx of selectedVerts) {
                verts[vIdx*3] += localDelta.x;
                verts[vIdx*3+1] += localDelta.y;
                verts[vIdx*3+2] += localDelta.z;
            }
        }
        this.registerAssetWithGPU(asset);
    }

    private applyDeformation(entityId: string) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset || !this.vertexSnapshot) return;

        const verts = asset.geometry.vertices;
        const snap = this.vertexSnapshot;
        const weights = this.softSelectionWeights.get(meshIntId);
        const delta = this.currentDeformationDelta;
        
        const selectedVerts = this.getSelectionAsVertices();

        if (this.softSelectionEnabled && weights) {
            for (let i = 0; i < weights.length; i++) {
                const w = weights[i];
                if (w > 0.001) {
                    verts[i*3] = snap[i*3] + delta.x * w;
                    verts[i*3+1] = snap[i*3+1] + delta.y * w;
                    verts[i*3+2] = snap[i*3+2] + delta.z * w;
                } else {
                    verts[i*3] = snap[i*3];
                    verts[i*3+1] = snap[i*3+1];
                    verts[i*3+2] = snap[i*3+2];
                }
            }
        } else {
            verts.set(snap);
            for (const vIdx of selectedVerts) {
                verts[vIdx*3] += delta.x;
                verts[vIdx*3+1] += delta.y;
                verts[vIdx*3+2] += delta.z;
            }
        }

        this.registerAssetWithGPU(asset);
    }

    endVertexDrag() {
    }

    clearDeformation() {
        this.vertexSnapshot = null;
        this.activeDeformationEntity = null;
        this.currentDeformationDelta = { x: 0, y: 0, z: 0 };
    }

    // --- LOOP SELECTION API ---
    selectLoop(mode: MeshComponentMode) {
        if (this.selectedIndices.size === 0) return;
        const idx = Array.from(this.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset || !asset.topology) return;

        const topo = asset.topology;

        if (mode === 'EDGE') {
            // Need at least 1 edge
            const edges = Array.from(this.subSelection.edgeIds);
            if (edges.length === 0) return;
            const lastEdge = edges[edges.length - 1];
            const [v1, v2] = lastEdge.split('-').map(Number);
            const loop = MeshTopologyUtils.getEdgeLoop(topo, v1, v2);
            loop.forEach(e => {
                const key = e.sort((a,b)=>a-b).join('-');
                this.subSelection.edgeIds.add(key);
            });
        } 
        else if (mode === 'VERTEX') {
            // Need at least 2 vertices to define direction
            const verts = Array.from(this.subSelection.vertexIds);
            if (verts.length < 2) {
                consoleService.warn('Select at least 2 vertices to define loop direction');
                return;
            }
            const v1 = verts[verts.length - 2];
            const v2 = verts[verts.length - 1];
            // Validate connection
            const key = [v1, v2].sort((a,b)=>a-b).join('-');
            if (topo.graph && topo.graph.edgeKeyToHalfEdge.has(key)) {
                const loop = MeshTopologyUtils.getVertexLoop(topo, v1, v2);
                loop.forEach(v => this.subSelection.vertexIds.add(v));
            } else {
                consoleService.warn('Selected vertices are not connected');
            }
        } 
        else if (mode === 'FACE') {
            // Need 2 adjacent faces to define strip direction
            const faces = Array.from(this.subSelection.faceIds);
            if (faces.length < 2) {
                consoleService.warn('Select at least 2 adjacent faces to define loop direction');
                return;
            }
            const f1 = faces[faces.length - 2];
            const f2 = faces[faces.length - 1];
            
            // Find shared edge vertices
            const verts1 = topo.faces[f1];
            const verts2 = topo.faces[f2];
            const shared = verts1.filter(v => verts2.includes(v));
            
            if (shared.length === 2) {
                const loop = MeshTopologyUtils.getFaceLoop(topo, shared[0], shared[1]);
                loop.forEach(f => this.subSelection.faceIds.add(f));
            } else {
                consoleService.warn('Faces are not adjacent');
            }
        }
        
        this.recalculateSoftSelection();
        this.notifyUI();
    }

    tick(dt: number) {
            const start = performance.now();
            const clampedDt = Math.min(dt, this.maxFrameTime);
            if (dt > 0) this.accumulator += clampedDt;

            while (this.accumulator >= this.fixedTimeStep) {
                this.fixedUpdate(this.fixedTimeStep);
                this.accumulator -= this.fixedTimeStep;
            }

            this.sceneGraph.update();
            moduleManager.update(dt);

            if (this.currentViewProj && !this.isPlaying) {
                this.debugRenderer.begin();
            }

            if (this.currentViewProj) {
                const softSel = { 
                    enabled: this.softSelectionEnabled && this.meshComponentMode !== 'OBJECT', 
                    center: {x:0,y:0,z:0}, 
                    radius: this.softSelectionRadius,
                    heatmapVisible: this.softSelectionHeatmapVisible
                };
                
                if (softSel.enabled && this.selectedIndices.size > 0) {
                     const idx = Array.from(this.selectedIndices)[0];
                     const id = this.ecs.store.ids[idx];
                     const wm = this.sceneGraph.getWorldMatrix(id);
                     
                     const useSnap = (this.softSelectionMode === 'FIXED' && this.vertexSnapshot);
                     const sourceV = useSnap ? this.vertexSnapshot! : (assetManager.getAsset(assetManager.meshIntToUuid.get(this.ecs.store.meshType[idx])!) as StaticMeshAsset)?.geometry.vertices;
                     
                     const activeVerts = this.getSelectionAsVertices();

                     if (sourceV && activeVerts.size > 0 && wm) {
                         const vId = Array.from(activeVerts)[0];
                         const lx = sourceV[vId*3], ly = sourceV[vId*3+1], lz = sourceV[vId*3+2];
                         const wx = wm[0]*lx + wm[4]*ly + wm[8]*lz + wm[12];
                         const wy = wm[1]*lx + wm[5]*ly + wm[9]*lz + wm[13];
                         const wz = wm[2]*lx + wm[6]*ly + wm[10]*lz + wm[14];
                         softSel.center = { x: wx, y: wy, z: wz };
                     } else if (wm) {
                         softSel.center = { x: wm[12], y: wm[13], z: wm[14] }; 
                     }
                }

                this.renderer.render(
                    this.ecs.store, 
                    this.ecs.count, 
                    this.selectedIndices, 
                    this.currentViewProj, 
                    this.currentWidth, 
                    this.currentHeight, 
                    this.currentCameraPos,
                    softSel,
                    this.isPlaying && this.simulationMode === 'GAME' ? undefined : this.debugRenderer,
                    this.selectedBoneIndex
                );
            }

            const end = performance.now();
            this.metrics.frameTime = end - start;
            if (dt > 0.0001) this.metrics.fps = 1 / dt;
            gizmoSystem.render();
            this.metrics.drawCalls = this.renderer.drawCalls;
            this.metrics.triangleCount = this.renderer.triangleCount;
            this.metrics.entityCount = this.ecs.count;
        }

        private fixedUpdate(fixedDt: number) {
            if (this.timeline.isPlaying) {
                this.timeline.currentTime += fixedDt * this.timeline.playbackSpeed;
                if (this.timeline.currentTime >= this.timeline.duration) {
                    if (this.timeline.isLooping) this.timeline.currentTime = 0;
                    else { 
                        this.timeline.currentTime = this.timeline.duration; 
                        this.timeline.isPlaying = false; 
                        this.isPlaying = false; 
                        this.simulationMode = 'STOPPED';
                        this.notifyUI();
                    }
                }
                // Run Animation System
                this.animationSystem.update(fixedDt, this.timeline.currentTime, this.meshSystem, this.ecs, this.sceneGraph);
            }

            if (this.isPlaying) {
                this.physicsSystem.update(fixedDt, this.ecs.store, this.ecs.idToIndex, this.sceneGraph);
            }

            const store = this.ecs.store;
            for(let i=0; i<this.ecs.count; i++) {
                if (store.isActive[i]) {
                    const id = store.ids[i];
                    const rigId = store.rigIndex[i];
                    if (rigId > 0) {
                        const assetId = assetManager.getRigUUID(rigId);
                        if(assetId) this.executeAssetGraph(id, assetId);
                    }
                }
            }
        }

    updateCamera(vpMatrix: Float32Array, eye: {x:number, y:number, z:number}, width: number, height: number) {
        this.currentViewProj = vpMatrix; this.currentCameraPos = eye; this.currentWidth = width; this.currentHeight = height;
    }

    setSelected(ids: string[]) {
        this.clearDeformation(); // Clear old deformation history on object switch
        this.selectedIndices.clear();
        ids.forEach(id => {
            const idx = this.ecs.idToIndex.get(id);
            if (idx !== undefined) this.selectedIndices.add(idx);
        });
        this.subSelection.vertexIds.clear(); this.subSelection.edgeIds.clear(); this.subSelection.faceIds.clear();
        this.hoveredVertex = null;
        this.recalculateSoftSelection(); // Clear weights on new selection
    }

    highlightVertexAt(mx: number, my: number, w: number, h: number) {
        if (this.meshComponentMode !== 'VERTEX' || this.selectedIndices.size === 0 || !this.currentViewProj) {
            this.hoveredVertex = null;
            return;
        }

        const idx = Array.from(this.selectedIndices)[0];
        const entityId = this.ecs.store.ids[idx];
        
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return;

        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return;

        const mvp = Mat4Utils.create();
        Mat4Utils.multiply(this.currentViewProj, worldMat, mvp);

        const verts = asset.geometry.vertices;
        let minDistSq = 20 * 20; 
        let closest = -1;

        for (let i = 0; i < verts.length / 3; i++) {
            const x = verts[i*3], y = verts[i*3+1], z = verts[i*3+2];
            const cx = mvp[0]*x + mvp[4]*y + mvp[8]*z + mvp[12];
            const cy = mvp[1]*x + mvp[5]*y + mvp[9]*z + mvp[13];
            const cw = mvp[3]*x + mvp[7]*y + mvp[11]*z + mvp[15];
            
            if (cw <= 0) continue; 
            const invW = 1.0 / cw;
            const sx = (cx * invW + 1) * 0.5 * w;
            const sy = (1 - cy * invW) * 0.5 * h; 
            
            const dx = sx - mx;
            const dy = sy - my;
            const dSq = dx*dx + dy*dy;
            
            if (dSq < minDistSq) {
                minDistSq = dSq;
                closest = i;
            }
        }

        if (closest !== -1) {
            this.hoveredVertex = { entityId, index: closest };
        } else {
            this.hoveredVertex = null;
        }
    }

    deleteEntity(id: string, sceneGraph: SceneGraph) { 
        const idx = this.ecs.idToIndex.get(id);
        const name = idx !== undefined ? this.ecs.store.names[idx] : 'Unknown Object';
        this.pushUndoState(); 
        this.ecs.deleteEntity(id, sceneGraph); 
        this.notifyUI();
        consoleService.info(`Deleted object: ${name}`);
    }

    duplicateEntity(id: string) {
        const idx = this.ecs.idToIndex.get(id);
        if (idx === undefined) return;
        
        const name = this.ecs.store.names[idx];
        const newId = this.ecs.createEntity(name + ' (Copy)');
        const newIdx = this.ecs.idToIndex.get(newId)!;
        
        const store = this.ecs.store;
        
        store.posX[newIdx] = store.posX[idx]; store.posY[newIdx] = store.posY[idx]; store.posZ[newIdx] = store.posZ[idx];
        store.rotX[newIdx] = store.rotX[idx]; store.rotY[newIdx] = store.rotY[idx]; store.rotZ[newIdx] = store.rotZ[idx];
        store.scaleX[newIdx] = store.scaleX[idx]; store.scaleY[newIdx] = store.scaleY[idx]; store.scaleZ[newIdx] = store.scaleZ[idx];
        store.rotationOrder[newIdx] = store.rotationOrder[idx];
        
        store.componentMask[newIdx] = store.componentMask[idx];
        store.meshType[newIdx] = store.meshType[idx]; store.materialIndex[newIdx] = store.materialIndex[idx];
        store.textureIndex[newIdx] = store.textureIndex[idx]; store.rigIndex[newIdx] = store.rigIndex[idx];
        store.effectIndex[newIdx] = store.effectIndex[idx];
        store.colorR[newIdx] = store.colorR[idx]; store.colorG[newIdx] = store.colorG[idx]; store.colorB[newIdx] = store.colorB[idx];
        
        store.mass[newIdx] = store.mass[idx]; store.useGravity[newIdx] = store.useGravity[idx];
        store.physicsMaterialIndex[newIdx] = store.physicsMaterialIndex[idx];
        
        store.lightType[newIdx] = store.lightType[idx]; store.lightIntensity[newIdx] = store.lightIntensity[idx];
        store.vpLength[newIdx] = store.vpLength[idx];
        
        this.sceneGraph.registerEntity(newId);
        const parent = this.sceneGraph.getParentId(id);
        if (parent) this.sceneGraph.attach(newId, parent);
        
        this.setSelected([newId]);
        this.pushUndoState();
        this.notifyUI();
        consoleService.success(`Duplicated: ${name}`);
    }
    
    deleteAsset(id: string) { assetManager.deleteAsset(id); this.notifyUI(); }
    notifyUI() { this.listeners.forEach(l => l()); }
    subscribe(cb: () => void) { this.listeners.push(cb); return () => { this.listeners = this.listeners.filter(l => l !== cb); }; }

    registerAssetWithGPU(asset: Asset) {
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            const internalId = assetManager.getMeshID(asset.id);
            if (internalId > 0) {
                this.meshSystem.registerMesh(internalId, asset.geometry);
                
                // Restore soft selection weights if they exist for this mesh
                if (this.softSelectionWeights.has(internalId)) {
                    this.meshSystem.updateSoftSelectionBuffer(internalId, this.softSelectionWeights.get(internalId)!);
                }
            }
        }
    }

    createEntityFromAsset(assetId: string, position: {x:number, y:number, z:number}): string | null {
        let asset = assetManager.getAsset(assetId);
        if (!asset) asset = assetManager.getAllAssets().find(a => a.name === assetId) || undefined;
        if (!asset) {
            consoleService.error(`Failed to create entity: Asset ${assetId} not found`);
            return null;
        }
        this.registerAssetWithGPU(asset);
        const id = this.ecs.createEntity(asset.name);
        this.sceneGraph.registerEntity(id);
        const idx = this.ecs.idToIndex.get(id)!;
        this.ecs.store.setPosition(idx, position.x, position.y, position.z);
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            this.ecs.addComponent(id, ComponentType.MESH);
            this.ecs.store.meshType[idx] = assetManager.getMeshID(asset.id);
        }
        this.notifyUI(); this.pushUndoState();
        consoleService.success(`Placed ${asset.name} in scene`);
        return id;
    }

    pushUndoState() { this.historySystem.pushState(this.ecs); }
    setRenderMode(modeId: number) { this.renderMode = modeId; this.renderer.renderMode = modeId; }
    toggleGrid() { this.renderer.showGrid = !this.renderer.showGrid; }
    syncTransforms() { this.sceneGraph.update(); }

    selectEntityAt(mx: number, my: number, w: number, h: number): string | null {
        if (!this.currentViewProj) return null;
        const invVP = new Float32Array(16); if(!Mat4Utils.invert(this.currentViewProj, invVP)) return null;
        const ray = RayUtils.create(); RayUtils.fromScreen(mx, my, w, h, invVP, ray);
        let closestDist = Infinity; let closestId: string | null = null;
        const store = this.ecs.store;
        for(let i=0; i<this.ecs.count; i++) {
            if(!store.isActive[i]) continue;
            const pos = { x: store.worldMatrix[i*16+12], y: store.worldMatrix[i*16+13], z: store.worldMatrix[i*16+14] };
            const radius = 0.5 * Math.max(store.scaleX[i], Math.max(store.scaleY[i], store.scaleZ[i])); 
            const t = RayUtils.intersectSphere(ray, pos, radius);
            if (t !== null && t < closestDist) { closestDist = t; closestId = store.ids[i]; }
        }
        return closestId;
    }

    pickMeshComponent(entityId: string, mx: number, my: number, w: number, h: number): MeshPickingResult | null {
        if (!this.currentViewProj) return null;
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return null;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return null;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset || !asset.topology) return null;
        const invVP = new Float32Array(16); Mat4Utils.invert(this.currentViewProj, invVP);
        const worldRay = RayUtils.create(); RayUtils.fromScreen(mx, my, w, h, invVP, worldRay);
        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return null;
        const invWorld = Mat4Utils.create(); Mat4Utils.invert(worldMat, invWorld);
        const localRay: Ray = { origin: Vec3Utils.transformMat4(worldRay.origin, invWorld, {x:0,y:0,z:0}), direction: Vec3Utils.transformMat4Normal(worldRay.direction, invWorld, {x:0,y:0,z:0}) };
        Vec3Utils.normalize(localRay.direction, localRay.direction);
        return MeshTopologyUtils.raycastMesh(asset.topology, asset.geometry.vertices, localRay, 0.05);
    }

    selectEntitiesInRect(rx: number, ry: number, rw: number, rh: number): string[] { 
        if (!this.currentViewProj || rw < 1 || rh < 1) return [];
        const width = this.currentWidth; const height = this.currentHeight;
        const selX1 = (rx / width) * 2 - 1; const selY1 = 1 - (ry / height) * 2;
        const selX2 = ((rx + rw) / width) * 2 - 1; const selY2 = 1 - ((ry + rh) / height) * 2;
        const selLeft = Math.min(selX1, selX2); const selRight = Math.max(selX1, selX2);
        const selBottom = Math.min(selY1, selY2); const selTop = Math.max(selY1, selY2);
        const hitIds: string[] = []; const store = this.ecs.store; const vp = this.currentViewProj;
        const corners = [ [-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5], [-0.5,-0.5,0.5],[0.5,-0.5,0.5],[-0.5,0.5,0.5],[0.5,0.5,0.5] ];
        for (let i = 0; i < this.ecs.count; i++) {
            if (!store.isActive[i]) continue;
            const base = i * 16; const wm = store.worldMatrix.subarray(base, base + 16);
            let screenMinX = Infinity, screenMaxX = -Infinity, screenMinY = Infinity, screenMaxY = -Infinity, anyInFront = false;
            for (let j = 0; j < 8; j++) {
                const cx = corners[j][0], cy = corners[j][1], cz = corners[j][2];
                const wx = wm[0]*cx + wm[4]*cy + wm[8]*cz + wm[12]; const wy = wm[1]*cx + wm[5]*cy + wm[9]*cz + wm[13]; const wz = wm[2]*cx + wm[6]*cy + wm[10]*cz + wm[14];
                const clipX = vp[0]*wx + vp[4]*wy + vp[8]*wz + vp[12]; const clipY = vp[1]*wx + vp[5]*wy + vp[9]*wz + vp[13]; const clipW = vp[3]*wx + vp[7]*wy + vp[11]*wz + vp[15];
                if (clipW > 0) {
                    const ndcX = clipX/clipW; const ndcY = clipY/clipW;
                    screenMinX = Math.min(screenMinX, ndcX); screenMaxX = Math.max(screenMaxX, ndcX);
                    screenMinY = Math.min(screenMinY, ndcY); screenMaxY = Math.max(screenMaxY, ndcY);
                    anyInFront = true;
                }
            }
            if (anyInFront && !(screenMaxX < selLeft || screenMinX > selRight || screenMaxY < selBottom || screenMinY > selTop)) hitIds.push(store.ids[i]);
        }
        return hitIds;
    }

    applyMaterialToSelected(assetId: string) { const matID = assetManager.getMaterialID(assetId); this.selectedIndices.forEach(idx => { this.ecs.store.materialIndex[idx] = matID; }); this.notifyUI(); }
    loadScene(json: string) { this.ecs.deserialize(json, this.sceneGraph); this.notifyUI(); }
    saveScene() { return this.ecs.serialize(); }

    compileGraph(nodes: GraphNode[], connections: GraphConnection[], assetId?: string) {
        if (assetId) {
            const res = compileShader(nodes, connections);
            if (typeof res !== 'string') { this.currentShaderSource = res.fs; const matID = assetManager.getMaterialID(assetId); this.meshSystem.updateMaterial(matID, res); }
        }
    }

    executeAssetGraph(entityId: string, assetId: string) {
        const asset = assetManager.getAsset(assetId);
        if(!asset || (asset.type !== 'SCRIPT' && asset.type !== 'RIG')) return;
        const nodes = asset.data.nodes; const connections = asset.data.connections;
        const context = { ecs: this.ecs, sceneGraph: this.sceneGraph, entityId: entityId, time: this.timeline.currentTime };
        const nodeMap = new Map(nodes.map(n => [n.id, n])); const computedValues = new Map<string, any>();
        const evaluatePin = (nodeId: string, pinId: string): any => {
            const key = `${nodeId}.${pinId}`; if(computedValues.has(key)) return computedValues.get(key);
            const conn = connections.find(c => c.toNode === nodeId && c.toPin === pinId);
            if(conn) { const val = evaluateNodeOutput(conn.fromNode, conn.fromPin); computedValues.set(key, val); return val; }
            const node = nodeMap.get(nodeId); if(node && node.data && node.data[pinId] !== undefined) return node.data[pinId];
            return undefined;
        };
        const evaluateNodeOutput = (nodeId: string, pinId: string): any => {
            const node = nodeMap.get(nodeId); if(!node) return null;
            const def = NodeRegistry[node.type]; if(!def) return null;
            if(def.execute) { const inputs = def.inputs.map(inp => evaluatePin(nodeId, inp.id)); const result = def.execute(inputs, node.data, context); return (result && typeof result === 'object' && pinId in result) ? result[pinId] : result; }
            return null;
        };
        nodes.filter(n => n.type === 'RigOutput' || n.type === 'SetEntityTransform').forEach(n => {
            const def = NodeRegistry[n.type]; if(def && def.inputs) def.inputs.forEach(inp => evaluatePin(n.id, inp.id));
            if(def && def.execute) { const inputs = def.inputs.map(inp => evaluatePin(n.id, inp.id)); def.execute(inputs, n.data, context); }
        });
    }

    getPostProcessConfig(): PostProcessConfig { return this.renderer.ppConfig; }
    setPostProcessConfig(config: PostProcessConfig) { this.renderer.ppConfig = config; }
    setGridConfig(config: GridConfiguration) {
        this.renderer.gridOpacity = config.opacity; this.renderer.gridSize = config.size; this.renderer.gridFadeDistance = config.fadeDistance;
        const hex = config.color.replace('#',''); const r = parseInt(hex.substring(0,2), 16)/255; const g = parseInt(hex.substring(2,4), 16)/255; const b = parseInt(hex.substring(4,6), 16)/255;
        this.renderer.gridColor = [r, g, b]; this.renderer.gridExcludePP = config.excludeFromPostProcess;
    }
    setUiConfig(config: UIConfiguration) { this.uiConfig = config; }

    // --- MESH OPS (STUBS FOR PIE MENU) ---
    extrudeFaces() { consoleService.info('Extrude Faces (Mock)', 'Modeling'); }
    bevelEdges() { consoleService.info('Bevel Edges (Mock)', 'Modeling'); }
    weldVertices() { consoleService.info('Weld Vertices (Mock)', 'Modeling'); }
    connectComponents() { consoleService.info('Connect Components (Mock)', 'Modeling'); }
    deleteSelectedFaces() { consoleService.info('Delete Faces (Mock)', 'Modeling'); }
}

export const engineInstance = new Engine();
(window as any).engineInstance = engineInstance;