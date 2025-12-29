
// services/engine.ts

import { SoAEntitySystem } from './ecs/EntitySystem';
import { SceneGraph } from './SceneGraph';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { HistorySystem } from './systems/HistorySystem';
import { WebGLRenderer, PostProcessConfig } from './renderers/WebGLRenderer';
import { DebugRenderer } from './renderers/DebugRenderer';
import { assetManager } from './AssetManager';
import { PerformanceMetrics, GraphNode, GraphConnection, ComponentType, TimelineState, MeshComponentMode, StaticMeshAsset, SkeletalMeshAsset, Asset, SimulationMode, Vector3, SoftSelectionFalloff } from '../types';
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
import * as THREE from 'three';

export type SoftSelectionMode = 'DYNAMIC' | 'FIXED';

export class Engine {
    ecs: SoAEntitySystem;
    sceneGraph: SceneGraph;
    physicsSystem: PhysicsSystem;
    historySystem: HistorySystem;
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
    
    // Cached weights for the current selection
    softSelectionWeights: Map<number, Float32Array> = new Map();

    // --- DEFORMATION SNAPSHOT STATE ---
    private vertexSnapshot: Float32Array | null = null;
    private currentDeformationDelta: Vector3 = { x: 0, y: 0, z: 0 };
    private activeDeformationEntity: string | null = null;

    // --- SKINNING STATE ---
    selectedBoneIndex: number = -1;
    private mixer: THREE.AnimationMixer | null = null;
    private clock = new THREE.Clock();
    private boneMatrices = new Float32Array(1024 * 16); // Buffer for bone transforms

    uiConfig: UIConfiguration = DEFAULT_UI_CONFIG;

    timeline: TimelineState = {
        currentTime: 0,
        duration: 10,
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
    private fixedTimeStep: number = 1 / 60; 
    private maxFrameTime: number = 0.1;     

    constructor() {
        this.ecs = new SoAEntitySystem();
        this.sceneGraph = new SceneGraph();
        this.sceneGraph.setContext(this.ecs);
        this.physicsSystem = new PhysicsSystem();
        this.historySystem = new HistorySystem();
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
    
    setTimelineTime(time: number) { 
        this.timeline.currentTime = Math.max(0, Math.min(time, this.timeline.duration));
        if (this.mixer) {
            this.mixer.setTime(this.timeline.currentTime);
        }
        this.notifyUI(); 
    }

    createVirtualPivot(name: string = 'Virtual Pivot') {
        const id = this.ecs.createEntity(name);
        this.ecs.addComponent(id, ComponentType.VIRTUAL_PIVOT);
        this.sceneGraph.registerEntity(id);
        this.pushUndoState();
        this.notifyUI();
        consoleService.info(`Created helper: ${name}`);
        return id;
    }

    // --- UI / STATE MANAGEMENT ---
    subscribe(cb: () => void) {
        this.listeners.push(cb);
        return () => {
            this.listeners = this.listeners.filter(l => l !== cb);
        };
    }

    notifyUI() {
        this.listeners.forEach(cb => cb());
    }

    pushUndoState() {
        this.historySystem.pushState(this.ecs);
    }

    setSelected(ids: string[]) {
        this.selectedIndices.clear();
        ids.forEach(id => {
            const idx = this.ecs.idToIndex.get(id);
            if (idx !== undefined) this.selectedIndices.add(idx);
        });
        this.recalculateSoftSelection();
        this.notifyUI();
    }

    // --- ASSET MANAGEMENT HOOKS ---
    compileGraph(nodes: GraphNode[], connections: GraphConnection[], assetId: string) {
        const result = compileShader(nodes, connections);
        if (typeof result !== 'string') {
            // It's a valid shader compilation result
            const matId = assetManager.getMaterialID(assetId);
            this.meshSystem.updateMaterial(matId, result);
            this.currentShaderSource = result.fs; // Store for debug/preview
        }
    }

    registerAssetWithGPU(asset: Asset) {
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            const intId = assetManager.getMeshID(asset.id);
            this.meshSystem.registerMesh(intId, (asset as StaticMeshAsset).geometry);
        }
    }

    createEntityFromAsset(assetId: string, pos: Vector3): string | null {
        // Try to find as standard asset first
        let asset = assetManager.getAsset(assetId);
        
        // If not found by ID, try by name (for procedural primitives created in AssetManager)
        if (!asset) {
            const allAssets = assetManager.getAllAssets();
            asset = allAssets.find(a => a.name === assetId);
        }

        if (!asset) return null;

        const id = this.ecs.createEntity(asset.name);
        const idx = this.ecs.idToIndex.get(id)!;
        
        this.ecs.store.setPosition(idx, pos.x, pos.y, pos.z);
        
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            this.ecs.addComponent(id, ComponentType.MESH);
            // Ensure asset is registered with integer ID
            const meshIntId = assetManager.registerAsset(asset); // Ensures UUID <-> Int mapping
            this.ecs.store.meshType[idx] = meshIntId;
            
            // Register with GPU if not already
            if (!this.meshSystem.meshes.has(meshIntId)) {
                this.registerAssetWithGPU(asset);
            }

            if (asset.type === 'SKELETAL_MESH') {
                this.ecs.store.rigIndex[idx] = assetManager.getRigID(asset.id);
                this.setupAnimation(asset as SkeletalMeshAsset);
            }
        }

        this.sceneGraph.registerEntity(id);
        this.pushUndoState();
        this.notifyUI();
        return id;
    }

    // --- SCENE OPERATIONS ---
    deleteEntity(id: string, sceneGraph: SceneGraph) {
        this.ecs.deleteEntity(id, sceneGraph);
        this.pushUndoState();
        this.notifyUI();
    }

    duplicateEntity(id: string) {
        const originalIdx = this.ecs.idToIndex.get(id);
        if (originalIdx === undefined) return;
        
        const name = this.ecs.store.names[originalIdx] + ' (Copy)';
        const newId = this.ecs.createEntity(name);
        const newIdx = this.ecs.idToIndex.get(newId)!;
        
        // Copy Component Mask
        this.ecs.store.componentMask[newIdx] = this.ecs.store.componentMask[originalIdx];
        
        // Copy Transform
        this.ecs.store.setPosition(newIdx, this.ecs.store.posX[originalIdx], this.ecs.store.posY[originalIdx], this.ecs.store.posZ[originalIdx]);
        this.ecs.store.setRotation(newIdx, this.ecs.store.rotX[originalIdx], this.ecs.store.rotY[originalIdx], this.ecs.store.rotZ[originalIdx]);
        this.ecs.store.setScale(newIdx, this.ecs.store.scaleX[originalIdx], this.ecs.store.scaleY[originalIdx], this.ecs.store.scaleZ[originalIdx]);
        this.ecs.store.rotationOrder[newIdx] = this.ecs.store.rotationOrder[originalIdx];
        
        // Copy Mesh Data
        this.ecs.store.meshType[newIdx] = this.ecs.store.meshType[originalIdx];
        this.ecs.store.materialIndex[newIdx] = this.ecs.store.materialIndex[originalIdx];
        this.ecs.store.textureIndex[newIdx] = this.ecs.store.textureIndex[originalIdx];
        this.ecs.store.colorR[newIdx] = this.ecs.store.colorR[originalIdx];
        this.ecs.store.colorG[newIdx] = this.ecs.store.colorG[originalIdx];
        this.ecs.store.colorB[newIdx] = this.ecs.store.colorB[originalIdx];
        
        this.sceneGraph.registerEntity(newId);
        this.pushUndoState();
        this.notifyUI();
        return newId;
    }

    syncTransforms() {
        this.sceneGraph.update();
    }

    // --- CONFIG ---
    setGridConfig(config: GridConfiguration) {
        this.renderer.gridOpacity = config.opacity;
        this.renderer.gridSize = config.size;
        this.renderer.gridSubdivisions = config.subdivisions;
        this.renderer.gridFadeDistance = config.fadeDistance;
        this.renderer.showGrid = config.visible;
        this.renderer.gridExcludePP = config.excludeFromPostProcess;
        const hex = config.color;
        const r = parseInt(hex.slice(1,3), 16)/255;
        const g = parseInt(hex.slice(3,5), 16)/255;
        const b = parseInt(hex.slice(5,7), 16)/255;
        this.renderer.gridColor = [r, g, b];
    }

    setUiConfig(config: UIConfiguration) {
        this.uiConfig = config;
    }

    getPostProcessConfig() { return this.renderer.ppConfig; }
    setPostProcessConfig(config: PostProcessConfig) { this.renderer.ppConfig = config; }
    
    toggleGrid() {
        this.renderer.showGrid = !this.renderer.showGrid;
    }
    
    setRenderMode(mode: number) {
        this.renderMode = mode;
        this.renderer.renderMode = mode;
    }

    saveScene(): string {
        return this.ecs.serialize();
    }

    loadScene(json: string) {
        this.ecs.deserialize(json, this.sceneGraph);
        this.notifyUI();
    }

    updateCamera(viewProj: Float32Array, camPos: Vector3, width: number, height: number) {
        this.currentViewProj = viewProj;
        this.currentCameraPos = camPos;
        this.currentWidth = width;
        this.currentHeight = height;
    }

    // --- SELECTION HELPERS ---
    getSelectionAsVertices(): Set<number> {
        // ... (Same as before) ...
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
                const indices = asset.geometry.indices;
                this.subSelection.faceIds.forEach(fIdx => {
                    result.add(indices[fIdx * 3]);
                    result.add(indices[fIdx * 3 + 1]);
                    result.add(indices[fIdx * 3 + 2]);
                });
            }
        }
        return result;
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
        // ... (Same as before) ...
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset) return;

        const verts = asset.geometry.vertices;
        const weights = this.softSelectionWeights.get(meshIntId);
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
        // ... (Same as before) ...
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

    endVertexDrag() { }

    clearDeformation() {
        this.vertexSnapshot = null;
        this.activeDeformationEntity = null;
        this.currentDeformationDelta = { x: 0, y: 0, z: 0 };
    }

    // --- PICKING / RAYCASTING ---
    selectEntityAt(mx: number, my: number, w: number, h: number): string | null {
        // Simple bounding box or raycast implementation
        // For simplicity, iterate entities, check distance to center in screenspace or ray-sphere
        if (!this.currentViewProj) return null;
        const ray = RayUtils.create();
        const invVP = Mat4Utils.create();
        Mat4Utils.invert(this.currentViewProj, invVP);
        RayUtils.fromScreen(mx, my, w, h, invVP, ray);

        let bestT = Infinity;
        let bestId = null;

        this.ecs.idToIndex.forEach((idx, id) => {
            if (!this.ecs.store.isActive[idx]) return;
            const px = this.ecs.store.posX[idx];
            const py = this.ecs.store.posY[idx];
            const pz = this.ecs.store.posZ[idx];
            // Simple sphere test
            const t = RayUtils.intersectSphere(ray, {x:px, y:py, z:pz}, 1.0); // Approx radius 1
            if (t !== null && t < bestT) {
                bestT = t;
                bestId = id;
            }
        });
        return bestId;
    }

    selectEntitiesInRect(x: number, y: number, w: number, h: number): string[] {
        // ... (Screen space projection logic would go here)
        return [];
    }

    pickMeshComponent(entityId: string, mx: number, my: number, w: number, h: number): MeshPickingResult | null {
        if (!this.currentViewProj) return null;
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return null;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset) return null;

        const ray = RayUtils.create();
        const invVP = Mat4Utils.create();
        Mat4Utils.invert(this.currentViewProj, invVP);
        RayUtils.fromScreen(mx, my, w, h, invVP, ray);

        // Transform ray to local space
        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return null;
        const invWorld = Mat4Utils.create();
        Mat4Utils.invert(worldMat, invWorld);
        
        const localRayOrigin = Vec3Utils.transformMat4(ray.origin, invWorld, {x:0,y:0,z:0});
        const localRayDir = Vec3Utils.transformMat4Normal(ray.direction, invWorld, {x:0,y:0,z:0});
        Vec3Utils.normalize(localRayDir, localRayDir);
        
        const localRay = { origin: localRayOrigin, direction: localRayDir };

        return MeshTopologyUtils.raycastMesh(asset.topology!, asset.geometry.vertices, localRay);
    }

    highlightVertexAt(mx: number, my: number, w: number, h: number) {
        // Helper for hover effect
        // Find closest vertex in screen space or raycast
        // ...
    }

    // --- MESH OPERATIONS ---
    extrudeFaces() { consoleService.warn("Extrude not implemented yet"); }
    bevelEdges() { consoleService.warn("Bevel not implemented yet"); }
    weldVertices() { consoleService.warn("Weld not implemented yet"); }
    connectComponents() { consoleService.warn("Connect not implemented yet"); }
    deleteSelectedFaces() { consoleService.warn("Delete Face not implemented yet"); }

    // --- LOOP SELECTION API ---
    computeVertexLoop(entityId: string, v1: number, v2: number): number[] {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return [];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset || !asset.topology) return [];

        const topo = asset.topology;
        const key = [v1, v2].sort((a,b)=>a-b).join('-');
        
        if (topo.graph && topo.graph.edgeKeyToHalfEdge.has(key)) {
            return MeshTopologyUtils.getVertexLoop(topo, v1, v2);
        } else {
            consoleService.warn('Vertices are not connected by a direct edge');
            return [];
        }
    }

    selectLoop(mode: MeshComponentMode) {
        if (this.selectedIndices.size === 0) return;
        const idx = Array.from(this.selectedIndices)[0];
        const entityId = this.ecs.store.ids[idx];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset || !asset.topology) return;

        const topo = asset.topology;

        if (mode === 'EDGE') {
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
            const verts = Array.from(this.subSelection.vertexIds);
            if (verts.length < 2) {
                consoleService.warn('Select at least 2 vertices to define loop direction');
                return;
            }
            const v1 = verts[verts.length - 2];
            const v2 = verts[verts.length - 1];
            const loop = this.computeVertexLoop(entityId, v1, v2);
            loop.forEach(v => this.subSelection.vertexIds.add(v));
        } 
        else if (mode === 'FACE') {
            const faces = Array.from(this.subSelection.faceIds);
            if (faces.length < 2) {
                consoleService.warn('Select at least 2 adjacent faces to define loop direction');
                return;
            }
            const f1 = faces[faces.length - 2];
            const f2 = faces[faces.length - 1];
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

    // --- SKINNING & ANIMATION ---
    
    setupAnimation(asset: SkeletalMeshAsset) {
        // Setup Three.js Skeleton & Mixer
        const bones: THREE.Bone[] = [];
        
        // Reconstruct hierarchy from flat bone array
        asset.skeleton.bones.forEach(bData => {
            const bone = new THREE.Bone();
            bone.name = bData.name;
            bones.push(bone);
        });
        
        asset.skeleton.bones.forEach((bData, i) => {
            if (bData.parentIndex !== -1) {
                bones[bData.parentIndex].add(bones[i]);
            }
        });
        
        const skeleton = new THREE.Skeleton(bones);
        // Apply bind poses
        asset.skeleton.bones.forEach((bData, i) => {
            const m = new THREE.Matrix4().fromArray(bData.bindPose);
            m.invert(); // invert bind pose to get rest matrix relative to parent if needed, but three handles this
            // Actually, we just need the skeleton structure for the mixer to animate
        });

        // Create a root group to hold the skeleton for the mixer
        const root = new THREE.Group();
        if (bones.length > 0) root.add(bones[0]); // Add root bone
        
        this.mixer = new THREE.AnimationMixer(root);
        
        // Load animations if any
        const anims = (window as any)._animations?.[asset.id];
        if (anims && anims.length > 0) {
            const clip = anims[0];
            const action = this.mixer.clipAction(clip);
            action.play();
            this.timeline.duration = clip.duration;
        } else {
            console.warn("No animations found for skeletal mesh");
        }
        
        // Store skeleton reference for updates
        (this as any)._activeSkeleton = skeleton;
    }

    updateAnimation(dt: number) {
        if (this.mixer) {
            if (this.timeline.isPlaying) {
                this.mixer.update(dt * this.timeline.playbackSpeed);
                this.timeline.currentTime = this.mixer.time % this.timeline.duration;
            } else {
                this.mixer.setTime(this.timeline.currentTime);
            }
            
            // Extract bone matrices
            const skeleton = (this as any)._activeSkeleton as THREE.Skeleton;
            if (skeleton) {
                skeleton.update();
                // We need boneMatrices: [Bone0InvBind * Bone0World, Bone1InvBind * Bone1World, ...]
                // THREE.Skeleton computes this in .boneMatrices if using WebGLRenderer, but we access manually
                
                // Manual computation:
                const boneTextureBuffer = this.boneMatrices;
                for (let i = 0; i < skeleton.bones.length; i++) {
                    const bone = skeleton.bones[i];
                    // standard three.js matrix world update is automatic in mixer.update() -> properties
                    // We need offsetMatrix * matrixWorld
                    // Skeleton.boneInverses contains the inverse bind matrices
                    
                    const inverse = skeleton.boneInverses[i];
                    const world = bone.matrixWorld;
                    
                    const mat = new THREE.Matrix4().multiplyMatrices(world, inverse);
                    // Copy to buffer
                    for(let k=0; k<16; k++) boneTextureBuffer[i*16+k] = mat.elements[k];
                }
                
                this.meshSystem.updateBoneMatrices(boneTextureBuffer);
            }
        }
    }

    paintSkinWeights(entityId: string, hitPoint: Vector3, radius: number, boneIndex: number, opacity: number, mode: 'ADD'|'REPLACE'|'SMOOTH'|'REMOVE') {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const uuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(uuid!) as SkeletalMeshAsset;
        if (!asset || asset.type !== 'SKELETAL_MESH') return;

        const verts = asset.geometry.vertices;
        const jIndices = asset.geometry.jointIndices;
        const jWeights = asset.geometry.jointWeights;
        const worldMat = this.sceneGraph.getWorldMatrix(entityId)!;
        
        const count = verts.length / 3;
        let modified = false;

        for (let i = 0; i < count; i++) {
            const lx = verts[i*3], ly = verts[i*3+1], lz = verts[i*3+2];
            // Transform to world
            const wx = worldMat[0]*lx + worldMat[4]*ly + worldMat[8]*lz + worldMat[12];
            const wy = worldMat[1]*lx + worldMat[5]*ly + worldMat[9]*lz + worldMat[13];
            const wz = worldMat[2]*lx + worldMat[6]*ly + worldMat[10]*lz + worldMat[14];
            
            const dist = Math.sqrt((wx - hitPoint.x)**2 + (wy - hitPoint.y)**2 + (wz - hitPoint.z)**2);
            
            if (dist <= radius) {
                // Gaussian falloff
                const falloff = Math.pow(1.0 - (dist / radius), 2.0) * opacity;
                
                // Find bone slot
                let slot = -1;
                for(let k=0; k<4; k++) {
                    if (Math.abs(jIndices[i*4+k] - boneIndex) < 0.1) {
                        slot = k; break;
                    }
                }
                
                if (slot === -1 && (mode === 'ADD' || mode === 'REPLACE')) {
                    // Find empty or lowest weight slot
                    let minW = 1000, minK = -1;
                    for(let k=0; k<4; k++) {
                        if (jWeights[i*4+k] < minW) { minW = jWeights[i*4+k]; minK = k; }
                    }
                    slot = minK;
                    jIndices[i*4+slot] = boneIndex;
                    jWeights[i*4+slot] = 0; // Prepare for add
                }

                if (slot !== -1) {
                    if (mode === 'ADD') jWeights[i*4+slot] += falloff;
                    else if (mode === 'REPLACE') jWeights[i*4+slot] = MathUtils.lerp(jWeights[i*4+slot], 1.0, falloff);
                    else if (mode === 'REMOVE') jWeights[i*4+slot] -= falloff;
                    
                    // Normalize
                    let total = 0;
                    for(let k=0; k<4; k++) total += jWeights[i*4+k];
                    if (total > 0) {
                        for(let k=0; k<4; k++) jWeights[i*4+k] /= total;
                    }
                    modified = true;
                }
            }
        }

        if (modified) {
            this.meshSystem.updateSkinWeightsBuffer(meshIntId, jWeights);
        }
    }

    fixedUpdate(dt: number) {
        this.physicsSystem.update(dt, this.ecs.store, this.ecs.idToIndex, this.sceneGraph);
    }

    tick(dt: number) {
            const start = performance.now();
            const clampedDt = Math.min(dt, this.maxFrameTime);
            if (dt > 0) this.accumulator += clampedDt;

            while (this.accumulator >= this.fixedTimeStep) {
                this.fixedUpdate(this.fixedTimeStep);
                this.accumulator -= this.fixedTimeStep;
            }
            
            this.updateAnimation(dt);

            this.sceneGraph.update();
            moduleManager.update(dt);

            if (this.currentViewProj && !this.isPlaying) {
                this.debugRenderer.begin();
                
                // Debug Skeleton
                if (this.renderMode === 6 && (this as any)._activeSkeleton) {
                    // Simple skeleton debug draw (simplified)
                }
            }
            
            if (this.currentViewProj) {
                const softSel = {
                    enabled: this.softSelectionEnabled && this.meshComponentMode !== 'OBJECT',
                    heatmapVisible: this.softSelectionHeatmapVisible,
                    center: {x:0,y:0,z:0}, radius: this.softSelectionRadius
                };
                
                this.renderer.render(
                    this.ecs.store, 
                    this.ecs.count, 
                    this.selectedIndices, 
                    this.currentViewProj, 
                    this.currentWidth, 
                    this.currentHeight, 
                    this.currentCameraPos, 
                    softSel, 
                    this.debugRenderer
                );
            }
    }
}

export const engineInstance = new Engine();