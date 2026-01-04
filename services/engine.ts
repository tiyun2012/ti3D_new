
// services/engine.ts

import { SoAEntitySystem } from './ecs/EntitySystem';
import { SceneGraph } from './SceneGraph';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { HistorySystem } from './systems/HistorySystem';
import { WebGLRenderer, PostProcessConfig } from './renderers/WebGLRenderer';
import { DebugRenderer } from './renderers/DebugRenderer';
import { assetManager } from './AssetManager';
import { PerformanceMetrics, GraphNode, GraphConnection, ComponentType, TimelineState, MeshComponentMode, StaticMeshAsset, Asset, SimulationMode, Vector3, SoftSelectionFalloff, SkeletalMeshAsset } from '../types';
import { Mat4Utils, RayUtils, Vec3Utils, Ray, MathUtils, AABBUtils } from './math';
import { compileShader } from './ShaderCompiler';
import { GridConfiguration, UIConfiguration, DEFAULT_UI_CONFIG } from '../contexts/EditorContext';
import { NodeRegistry } from './NodeRegistry';
import { MeshTopologyUtils, MeshPickingResult } from './MeshTopologyUtils';
import { gizmoSystem } from './GizmoSystem';
import { moduleManager } from './ModuleManager';
import { registerCoreModules } from './modules/CoreModules';
import { consoleService } from './Console';
import type { MeshRenderSystem } from './systems/MeshRenderSystem';
import { ParticleSystem } from './systems/ParticleSystem';
import { AnimationSystem } from './systems/AnimationSystem'; // Added
import { COMPONENT_MASKS } from './constants';

export type SoftSelectionMode = 'DYNAMIC' | 'FIXED';

export class Engine {
    ecs: SoAEntitySystem;
    sceneGraph: SceneGraph;
    physicsSystem: PhysicsSystem;
    historySystem: HistorySystem;
    particleSystem: ParticleSystem; 
    animationSystem: AnimationSystem; // Added
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
        this.particleSystem = new ParticleSystem(); 
        this.animationSystem = new AnimationSystem(); // Added
        this.renderer = new WebGLRenderer();
        this.debugRenderer = new DebugRenderer();
        this.metrics = { fps: 0, frameTime: 0, drawCalls: 0, triangleCount: 0, entityCount: 0 };
        
        // Expose to window for legacy/debug access
        (window as any).engineInstance = this;

        // Register Modules first (this creates the Systems)
        // Pass specific system instances to modules to ensure shared state
        registerCoreModules(this.physicsSystem, this.particleSystem, this.animationSystem);
        
        moduleManager.init({
            engine: this,
            ecs: this.ecs,
            scene: this.sceneGraph
        });
    }

    get meshSystem(): MeshRenderSystem {
        return this.renderer.meshSystem;
    }

    // --- Core API ---

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

    registerAssetWithGPU(asset: Asset) {
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            const intId = assetManager.getMeshID(asset.id);
            if (intId > 0) {
                // Cast to StaticMeshAsset to access geometry
                this.meshSystem.registerMesh(intId, (asset as StaticMeshAsset).geometry);
            }
        }
    }

    initGL(canvas: HTMLCanvasElement) {
        this.renderer.init(canvas);
        this.renderer.initGizmo();
        this.debugRenderer.init(this.renderer.gl!);
        
        // 1. Provide GL context to ModuleManager (re-init systems like Particles)
        if (this.renderer.gl) {
             moduleManager.init({
                engine: this,
                ecs: this.ecs,
                scene: this.sceneGraph,
                gl: this.renderer.gl
            });
        }

        // 2. Upload all existing mesh assets to GPU (Essential for rendering)
        assetManager.getAssetsByType('MESH').forEach(asset => this.registerAssetWithGPU(asset));
        assetManager.getAssetsByType('SKELETAL_MESH').forEach(asset => this.registerAssetWithGPU(asset));
        
        this.recompileAllMaterials();
        if (this.ecs.count === 0) this.createDefaultScene();
    }

    setGridConfig(config: GridConfiguration) {
        this.renderer.showGrid = config.visible;
        this.renderer.gridOpacity = config.opacity;
        this.renderer.gridSize = config.size;
        this.renderer.gridSubdivisions = config.subdivisions;
        this.renderer.gridFadeDistance = config.fadeDistance;
        this.renderer.gridExcludePP = config.excludeFromPostProcess;
        
        if (config.color) {
            const hex = config.color;
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            this.renderer.gridColor = [r, g, b];
        }
        this.notifyUI();
    }

    setUiConfig(config: UIConfiguration) {
        this.uiConfig = config;
        this.notifyUI();
    }

    recompileAllMaterials() {
        assetManager.getAssetsByType('MATERIAL').forEach(asset => {
            if (asset.type === 'MATERIAL') this.compileGraph(asset.data.nodes, asset.data.connections, asset.id);
        });
    }

    compileGraph(nodes: GraphNode[], connections: GraphConnection[], assetId: string) {
        const asset = assetManager.getAsset(assetId);
        if (asset && asset.type === 'MATERIAL') {
            const shaderData = compileShader(nodes, connections);
            if (typeof shaderData !== 'string') {
                const matIntId = assetManager.getMaterialID(assetId);
                if (matIntId > 0) {
                    this.meshSystem.updateMaterial(matIntId, shaderData);
                    this.currentShaderSource = shaderData.fs;
                }
            } else {
                consoleService.error(`Shader Compile Error: ${shaderData}`);
            }
        } else if (asset && (asset.type === 'SCRIPT' || asset.type === 'RIG')) {
             assetManager.saveScript(assetId, nodes, connections);
        }
    }

    createEntityFromAsset(assetId: string, pos: {x:number, y:number, z:number}) {
        const id = this.ecs.createEntity('New Object');
        const idx = this.ecs.idToIndex.get(id);
        if (idx !== undefined) {
            this.ecs.store.setPosition(idx, pos.x, pos.y, pos.z);
            
            const asset = assetManager.getAsset(assetId);
            if (asset) {
                this.ecs.store.names[idx] = asset.name;
                if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
                    this.ecs.addComponent(id, ComponentType.MESH);
                    this.ecs.store.meshType[idx] = assetManager.getMeshID(asset.id);
                }
            } else if (assetId.startsWith('SM_')) {
                const primName = assetId.replace('SM_', '');
                const all = assetManager.getAssetsByType('MESH');
                const found = all.find(a => a.name === `SM_${primName}`);
                if (found) {
                    this.ecs.store.names[idx] = primName;
                    this.ecs.addComponent(id, ComponentType.MESH);
                    this.ecs.store.meshType[idx] = assetManager.getMeshID(found.id);
                }
            }
            
            this.sceneGraph.registerEntity(id);
            this.notifyUI();
            this.pushUndoState();
        }
        return id;
    }

    deleteEntity(id: string, sceneGraph: SceneGraph) {
        this.pushUndoState();
        this.ecs.deleteEntity(id, sceneGraph);
        this.notifyUI();
    }

    duplicateEntity(id: string) {
        const idx = this.ecs.idToIndex.get(id);
        if (idx === undefined) return;
        
        this.pushUndoState();
        const newId = this.ecs.createEntity(this.ecs.store.names[idx] + " (Copy)");
        const newIdx = this.ecs.idToIndex.get(newId)!;
        
        // Copy components (shallow copy of stores for now)
        const store = this.ecs.store;
        store.componentMask[newIdx] = store.componentMask[idx];
        
        // Transform
        store.posX[newIdx] = store.posX[idx]; store.posY[newIdx] = store.posY[idx]; store.posZ[newIdx] = store.posZ[idx];
        store.rotX[newIdx] = store.rotX[idx]; store.rotY[newIdx] = store.rotY[idx]; store.rotZ[newIdx] = store.rotZ[idx];
        store.scaleX[newIdx] = store.scaleX[idx]; store.scaleY[newIdx] = store.scaleY[idx]; store.scaleZ[newIdx] = store.scaleZ[idx];
        
        // Mesh
        store.meshType[newIdx] = store.meshType[idx];
        store.materialIndex[newIdx] = store.materialIndex[idx];
        
        this.sceneGraph.registerEntity(newId);
        this.notifyUI();
        consoleService.info(`Duplicated entity: ${id} -> ${newId}`);
    }

    saveScene(): string {
        return this.ecs.serialize();
    }

    loadScene(json: string) {
        this.ecs.deserialize(json, this.sceneGraph);
        this.notifyUI();
    }

    getPostProcessConfig() {
        return this.renderer.ppConfig;
    }

    setPostProcessConfig(config: PostProcessConfig) {
        this.renderer.ppConfig = config;
        this.renderer.recompilePostProcess();
        this.notifyUI();
    }

    setRenderMode(mode: number) {
        this.renderer.renderMode = mode;
        this.notifyUI();
    }

    toggleGrid() {
        this.renderer.showGrid = !this.renderer.showGrid;
        this.notifyUI();
    }

    syncTransforms() {
        this.sceneGraph.update();
        this.notifyUI();
    }

    private createDefaultScene() {
        const standardMat = assetManager.getAssetsByType('MATERIAL').find(a => a.name === 'Standard');
        
        // 1. Holographic Cube
        const cubeId = this.createEntityFromAsset('SM_Cube', { x: -1.5, y: 0, z: 0 });
        if (cubeId && standardMat) {
            const idx = this.ecs.idToIndex.get(cubeId);
            if (idx !== undefined) {
                this.ecs.store.materialIndex[idx] = assetManager.getMaterialID(standardMat.id);
                // Apply Hologram Effect (ID 101)
                this.ecs.store.effectIndex[idx] = 101; 
                this.ecs.store.names[idx] = "Holo Cube";
            }
        }

        // 2. Normal Sphere
        const sphereId = this.createEntityFromAsset('SM_Sphere', { x: 1.5, y: 0, z: 0 });
        if (sphereId && standardMat) {
            const idx = this.ecs.idToIndex.get(sphereId);
            if (idx !== undefined) this.ecs.store.materialIndex[idx] = assetManager.getMaterialID(standardMat.id);
        }

        // 3. Fire Particles
        const fire = this.ecs.createEntity('Campfire Particles');
        this.ecs.addComponent(fire, ComponentType.TRANSFORM);
        this.ecs.addComponent(fire, ComponentType.PARTICLE_SYSTEM);
        const fireIdx = this.ecs.idToIndex.get(fire)!;
        this.ecs.store.setPosition(fireIdx, 0, 0, 0);
        this.sceneGraph.registerEntity(fire);
        
        // 4. Light
        const light = this.ecs.createEntity('Directional Light');
        this.ecs.addComponent(light, ComponentType.LIGHT);
        const idx = this.ecs.idToIndex.get(light)!;
        this.ecs.store.setPosition(idx, 5, 10, 5);
        this.ecs.store.setRotation(idx, -0.785, 0.785, 0); 
        this.sceneGraph.registerEntity(light);

        // 5. Virtual Pivot (PRESERVED)
        const pivot = this.ecs.createEntity('Virtual Pivot');
        this.ecs.addComponent(pivot, ComponentType.VIRTUAL_PIVOT);
        const pIdx = this.ecs.idToIndex.get(pivot)!;
        this.ecs.store.setPosition(pIdx, 0, 2, 0);
        this.sceneGraph.registerEntity(pivot);
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

    paintSkinWeights(entityId: string, worldPos: Vector3, boneIndex: number, weight: number, mode: 'ADD'|'REPLACE'|'SMOOTH'|'REMOVE', radius: number) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const uuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!uuid) return;
        const asset = assetManager.getAsset(uuid) as SkeletalMeshAsset;
        if (!asset || asset.type !== 'SKELETAL_MESH') return;

        const verts = asset.geometry.vertices;
        const jointIndices = asset.geometry.jointIndices;
        const jointWeights = asset.geometry.jointWeights;
        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return;

        const count = verts.length / 3;
        let modified = false;

        // Collect vertices in brush range first
        const inRange: {idx: number, dist: number, strength: number}[] = [];
        let sumWeights = 0;
        
        for (let i = 0; i < count; i++) {
            const vx = verts[i*3], vy = verts[i*3+1], vz = verts[i*3+2];
            const wx = worldMat[0]*vx + worldMat[4]*vy + worldMat[8]*vz + worldMat[12];
            const wy = worldMat[1]*vx + worldMat[5]*vy + worldMat[9]*vz + worldMat[13];
            const wz = worldMat[2]*vx + worldMat[6]*vy + worldMat[10]*vz + worldMat[14];
            
            const dist = Math.sqrt((wx - worldPos.x)**2 + (wy - worldPos.y)**2 + (wz - worldPos.z)**2);
            
            if (dist <= radius) {
                const falloff = Math.pow(1.0 - (dist / radius), 2);
                const strength = weight * falloff;
                inRange.push({idx: i, dist, strength});
                
                // For smoothing: calc current total bone weight in area
                if (mode === 'SMOOTH') {
                    for(let k=0; k<4; k++) {
                        if (jointIndices[i*4+k] === boneIndex) sumWeights += jointWeights[i*4+k];
                    }
                }
            }
        }

        const avgWeight = inRange.length > 0 ? sumWeights / inRange.length : 0;

        for (const {idx: i, strength} of inRange) {
            let slot = -1;
            let emptySlot = -1;
            
            for(let k=0; k<4; k++) {
                if (jointIndices[i*4+k] === boneIndex) slot = k;
                if (jointWeights[i*4+k] === 0) emptySlot = k;
            }

            if (slot === -1 && emptySlot !== -1) {
                slot = emptySlot;
                jointIndices[i*4+slot] = boneIndex;
            } else if (slot === -1) {
                let minW = 2.0; let minK = 0;
                for(let k=0; k<4; k++) { if (jointWeights[i*4+k] < minW) { minW = jointWeights[i*4+k]; minK = k; } }
                slot = minK;
                jointIndices[i*4+slot] = boneIndex;
                jointWeights[i*4+slot] = 0;
            }

            const currentW = jointWeights[i*4+slot];

            if (mode === 'ADD') {
                jointWeights[i*4+slot] = Math.min(1.0, currentW + strength * 0.1);
            } else if (mode === 'REPLACE') {
                jointWeights[i*4+slot] = MathUtils.lerp(currentW, strength, 0.5);
            } else if (mode === 'REMOVE') {
                jointWeights[i*4+slot] = Math.max(0.0, currentW - strength * 0.1);
            } else if (mode === 'SMOOTH') {
                // Blend towards average
                jointWeights[i*4+slot] = MathUtils.lerp(currentW, avgWeight, strength * 0.5);
            }

            // Normalize weights
            let sum = 0;
            for(let k=0; k<4; k++) sum += jointWeights[i*4+k];
            if (sum > 0) {
                const scale = 1.0 / sum;
                for(let k=0; k<4; k++) jointWeights[i*4+k] *= scale;
            }
            
            modified = true;
        }

        if (modified) {
            this.registerAssetWithGPU(asset);
        }
    }

    floodSkinWeights(entityId: string, boneIndex: number, value: number) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const asset = assetManager.getAsset(assetManager.meshIntToUuid.get(this.ecs.store.meshType[idx])!) as SkeletalMeshAsset;
        if(!asset || asset.type !== 'SKELETAL_MESH') return;

        const count = asset.geometry.vertices.length / 3;
        for (let i = 0; i < count; i++) {
            // Find slot or empty
            let slot = -1;
            for(let k=0; k<4; k++) if(asset.geometry.jointIndices[i*4+k] === boneIndex) slot = k;
            
            if(slot === -1) {
                // Find empty or min
                let minW = 2.0; let minK = 0;
                for(let k=0; k<4; k++) { 
                    if(asset.geometry.jointWeights[i*4+k] < minW) { minW = asset.geometry.jointWeights[i*4+k]; minK = k; } 
                }
                slot = minK;
                asset.geometry.jointIndices[i*4+slot] = boneIndex;
            }
            asset.geometry.jointWeights[i*4+slot] = value;
            
            // Normalize
            let sum = 0;
            for(let k=0; k<4; k++) sum += asset.geometry.jointWeights[i*4+k];
            if(sum > 0) {
                const s = 1.0/sum;
                for(let k=0; k<4; k++) asset.geometry.jointWeights[i*4+k] *= s;
            }
        }
        this.registerAssetWithGPU(asset);
        consoleService.success('Flooded Skin Weights');
    }

    pruneSkinWeights(entityId: string, threshold: number) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const asset = assetManager.getAsset(assetManager.meshIntToUuid.get(this.ecs.store.meshType[idx])!) as SkeletalMeshAsset;
        if(!asset || asset.type !== 'SKELETAL_MESH') return;

        const count = asset.geometry.vertices.length / 3;
        let pruned = 0;
        for (let i = 0; i < count; i++) {
            for(let k=0; k<4; k++) {
                if(asset.geometry.jointWeights[i*4+k] < threshold) {
                    asset.geometry.jointWeights[i*4+k] = 0;
                    asset.geometry.jointIndices[i*4+k] = 0;
                    pruned++;
                }
            }
            // Normalize
            let sum = 0;
            for(let k=0; k<4; k++) sum += asset.geometry.jointWeights[i*4+k];
            if(sum > 0) {
                const s = 1.0/sum;
                for(let k=0; k<4; k++) asset.geometry.jointWeights[i*4+k] *= s;
            }
        }
        this.registerAssetWithGPU(asset);
        consoleService.info(`Pruned ${pruned} small weights (<${threshold})`);
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
            const key = [v1, v2].sort((a,b)=>a-b).join('-');
            if (topo.graph && topo.graph.edgeKeyToHalfEdge.has(key)) {
                const loop = MeshTopologyUtils.getVertexLoop(topo, v1, v2);
                loop.forEach(v => this.subSelection.vertexIds.add(v));
            } else {
                consoleService.warn('Selected vertices are not connected');
            }
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

    tick(dt: number) {
            const start = performance.now();
            const clampedDt = Math.min(dt, this.maxFrameTime);
            if (dt > 0) this.accumulator += clampedDt;

            // Updated: Use ModuleManager to update all registered systems
            // This decouples Engine from specific systems (Physics, Particles, etc)
            // Removes direct updates to particle/animation systems to avoid double-update
            moduleManager.update(clampedDt);

            while (this.accumulator >= this.fixedTimeStep) {
                this.fixedUpdate(this.fixedTimeStep);
                this.accumulator -= this.fixedTimeStep;
            }

            this.sceneGraph.update();

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
                    this.particleSystem
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
            }

            // Note: Physics is managed by ModuleManager.update now.
            // If strict fixed-step physics is required, we would invoke a specific fixed-update 
            // method on the module manager here, but for this architecture we use the variable step.

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
        this.clearDeformation(); 
        this.selectedIndices.clear();
        ids.forEach(id => {
            const idx = this.ecs.idToIndex.get(id);
            if (idx !== undefined) this.selectedIndices.add(idx);
        });
        this.subSelection.vertexIds.clear(); this.subSelection.edgeIds.clear(); this.subSelection.faceIds.clear();
        this.hoveredVertex = null;
        this.recalculateSoftSelection(); 
    }

    selectEntityAt(mx: number, my: number, width: number, height: number): string | null {
        if (!this.currentViewProj) return null;
        
        const invVP = new Float32Array(16);
        if (!Mat4Utils.invert(this.currentViewProj, invVP)) return null;

        const ray = RayUtils.create();
        RayUtils.fromScreen(mx, my, width, height, invVP, ray);

        let closestDist = Infinity;
        let closestId: string | null = null;

        for (let i = 0; i < this.ecs.count; i++) {
            if (!this.ecs.store.isActive[i]) continue;
            
            const mask = this.ecs.store.componentMask[i];
            const hasMesh = !!(mask & COMPONENT_MASKS.MESH);
            
            if (!hasMesh && !((mask & COMPONENT_MASKS.LIGHT) || (mask & COMPONENT_MASKS.PARTICLE_SYSTEM) || (mask & COMPONENT_MASKS.VIRTUAL_PIVOT))) continue;

            const id = this.ecs.store.ids[i];
            const wmOffset = i * 16;
            const worldMat = this.ecs.store.worldMatrix.subarray(wmOffset, wmOffset + 16);
            
            let t: number | null = null;

            if (hasMesh) {
                const meshIntId = this.ecs.store.meshType[i];
                const uuid = assetManager.meshIntToUuid.get(meshIntId);
                const asset = uuid ? assetManager.getAsset(uuid) as StaticMeshAsset : null;
                
                if (asset && asset.geometry.aabb) {
                    const invWorld = Mat4Utils.create();
                    if (Mat4Utils.invert(worldMat, invWorld)) {
                        const localRay = RayUtils.create();
                        Vec3Utils.transformMat4(ray.origin, invWorld, localRay.origin);
                        Vec3Utils.transformMat4Normal(ray.direction, invWorld, localRay.direction);
                        Vec3Utils.normalize(localRay.direction, localRay.direction);
                        
                        // 1. Fast AABB Check
                        const aabbT = RayUtils.intersectAABB(localRay, asset.geometry.aabb);
                        
                        if (aabbT !== null) {
                            // 2. Precise BVH Triangle Check
                            if (asset.topology) {
                                // Now extremely fast O(logN)
                                const res = MeshTopologyUtils.raycastMesh(asset.topology, asset.geometry.vertices, localRay);
                                if (res) {
                                    // Transform hit distance back to world
                                    const worldHit = Vec3Utils.transformMat4(res.worldPos, worldMat, {x:0,y:0,z:0});
                                    t = Vec3Utils.distance(ray.origin, worldHit);
                                }
                                // If topology exists but raycastMesh returns null, we intentionally leave t as null (Precision enforced)
                            } else {
                                // Fallback for meshes without topology (legacy/simple)
                                const hitLocal = Vec3Utils.add(localRay.origin, Vec3Utils.scale(localRay.direction, aabbT, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                                const worldHit = Vec3Utils.transformMat4(hitLocal, worldMat, {x:0,y:0,z:0});
                                t = Vec3Utils.distance(ray.origin, worldHit);
                            }
                        }
                    }
                }
            } else {
                // Sphere pick for non-mesh entities
                const pos = { x: worldMat[12], y: worldMat[13], z: worldMat[14] };
                t = RayUtils.intersectSphere(ray, pos, 0.5);
            }
            
            if (t !== null && t < closestDist) {
                closestDist = t;
                closestId = id;
            }
        }
        return closestId;
    }

    selectEntitiesInRect(x: number, y: number, w: number, h: number): string[] {
        if (!this.currentViewProj) return [];
        const ids: string[] = [];
        
        // Marquee bounds
        const selLeft = x;
        const selRight = x + w;
        const selTop = y;
        const selBottom = y + h;

        for (let i = 0; i < this.ecs.count; i++) {
            if (!this.ecs.store.isActive[i]) continue;
            
            const id = this.ecs.store.ids[i];
            const mask = this.ecs.store.componentMask[i];
            const hasMesh = !!(mask & COMPONENT_MASKS.MESH);
            
            const wmOffset = i * 16;
            const worldMatrix = this.ecs.store.worldMatrix.subarray(wmOffset, wmOffset + 16);

            // We will project points to screen space to form a 2D bounding box
            let screenMinX = Infinity, screenMinY = Infinity;
            let screenMaxX = -Infinity, screenMaxY = -Infinity;
            let pointsToCheck: {x:number, y:number, z:number}[] = [];

            if (hasMesh) {
                // 1. Get Mesh AABB corners
                const meshIntId = this.ecs.store.meshType[i];
                const uuid = assetManager.meshIntToUuid.get(meshIntId);
                const asset = uuid ? assetManager.getAsset(uuid) as StaticMeshAsset : null;
                
                if (asset && asset.geometry.aabb) {
                    const { min, max } = asset.geometry.aabb;
                    // Local Space Corners
                    const localCorners = [
                        {x: min.x, y: min.y, z: min.z}, {x: max.x, y: min.y, z: min.z},
                        {x: min.x, y: max.y, z: min.z}, {x: max.x, y: max.y, z: min.z},
                        {x: min.x, y: min.y, z: max.z}, {x: max.x, y: min.y, z: max.z},
                        {x: min.x, y: max.y, z: max.z}, {x: max.x, y: max.y, z: max.z}
                    ];
                    // Transform to World Space
                    pointsToCheck = localCorners.map(p => Vec3Utils.transformMat4(p, worldMatrix, {x:0,y:0,z:0}));
                }
            }

            // Fallback: If no mesh or AABB, just check the center position
            if (pointsToCheck.length === 0) {
                pointsToCheck.push({ 
                    x: worldMatrix[12], 
                    y: worldMatrix[13], 
                    z: worldMatrix[14] 
                });
            }

            // 2. Project World Points to Screen Space
            let visiblePoints = 0;
            const m = this.currentViewProj;

            for (const p of pointsToCheck) {
                // Check if point is in front of camera (W > 0)
                const wVal = m[3]*p.x + m[7]*p.y + m[11]*p.z + m[15];
                if (wVal <= 0.001) continue; // Skip points behind camera

                const clip = Vec3Utils.transformMat4(p, m, {x:0, y:0, z:0});
                
                // Convert NDC to Screen Coords
                // Note: transformMat4 does the perspective divide, so clip.x/y are -1 to 1
                const sx = (clip.x * 0.5 + 0.5) * this.currentWidth;
                const sy = (1.0 - (clip.y * 0.5 + 0.5)) * this.currentHeight; // Invert Y for screen space

                screenMinX = Math.min(screenMinX, sx);
                screenMinY = Math.min(screenMinY, sy);
                screenMaxX = Math.max(screenMaxX, sx);
                screenMaxY = Math.max(screenMaxY, sy);
                visiblePoints++;
            }

            // If entire object is behind camera, skip
            if (visiblePoints === 0) continue;

            // 3. Check for Overlap (AABB vs Rect Intersection)
            // If the 2D projected box overlaps the marquee box at all, select it.
            const overlaps = !(screenMaxX < selLeft || screenMinX > selRight || screenMaxY < selTop || screenMinY > selBottom);

            if (overlaps) {
                ids.push(id);
            }
        }
        return ids;
    }

    pickMeshComponent(entityId: string, mx: number, my: number, width: number, height: number): MeshPickingResult | null {
        if (!this.currentViewProj) return null;
        
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return null;
        
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return null;
        
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset || (asset.type !== 'MESH' && asset.type !== 'SKELETAL_MESH') || !asset.topology) return null;

        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return null;

        const invWorld = Mat4Utils.create();
        if (!Mat4Utils.invert(worldMat, invWorld)) return null;

        const invVP = new Float32Array(16);
        Mat4Utils.invert(this.currentViewProj, invVP);

        const rayWorld = RayUtils.create();
        RayUtils.fromScreen(mx, my, width, height, invVP, rayWorld);

        const rayLocal = RayUtils.create();
        Vec3Utils.transformMat4(rayWorld.origin, invWorld, rayLocal.origin);
        Vec3Utils.transformMat4Normal(rayWorld.direction, invWorld, rayLocal.direction);
        Vec3Utils.normalize(rayLocal.direction, rayLocal.direction);

        const result = MeshTopologyUtils.raycastMesh(asset.topology, asset.geometry.vertices, rayLocal);
        
        if (result) {
            Vec3Utils.transformMat4(result.worldPos, worldMat, result.worldPos);
            return result;
        }
        return null;
    }

    // Optimized Vertex Highlighting (No linear scan)
    highlightVertexAt(mx: number, my: number, w: number, h: number) {
        if (this.meshComponentMode !== 'VERTEX' || this.selectedIndices.size === 0 || !this.currentViewProj) {
            this.hoveredVertex = null;
            return;
        }

        const idx = Array.from(this.selectedIndices)[0];
        const entityId = this.ecs.store.ids[idx];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        
        if (!asset || !asset.topology) return;

        // Use pickMeshComponent which uses the BVH
        const pick = this.pickMeshComponent(entityId, mx, my, w, h);
        
        if (pick) {
            // Check distance to closest vertex on the hit face
            // We use a generous screen-space feel by checking 3D distance to the precise hit point
            const vPos = {
                x: asset.geometry.vertices[pick.vertexId*3],
                y: asset.geometry.vertices[pick.vertexId*3+1],
                z: asset.geometry.vertices[pick.vertexId*3+2]
            };
            
            // Check world distance between precise ray hit and the vertex
            const dist = Vec3Utils.distance(pick.worldPos, vPos); // Note: worldPos here is Local Space from pickMeshComponent
            
            // Simple threshold in local units (approx 0.1 units)
            // For better UX, you might want to project to screen space, but this is much faster
            if (dist < 0.2) { 
                this.hoveredVertex = { entityId, index: pick.vertexId };
                return;
            }
        }
        
        this.hoveredVertex = null;
    }

    // New: Brush Selection Logic
    // Call this when dragging mouse with a "Paint" tool active
    selectVerticesInBrush(mx: number, my: number, width: number, height: number, add: boolean = true) {
        if (this.selectedIndices.size === 0 || !this.currentViewProj) return;

        const idx = Array.from(this.selectedIndices)[0];
        const entityId = this.ecs.store.ids[idx];
        const meshIntId = this.ecs.store.meshType[idx];
        const asset = assetManager.getAsset(assetManager.meshIntToUuid.get(meshIntId)!) as StaticMeshAsset;

        if (!asset || !asset.topology) return;

        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return;

        // 1. Raycast to find brush center on mesh surface
        const pick = this.pickMeshComponent(entityId, mx, my, width, height);
        if (!pick) return;

        // 2. Find all vertices in radius (using the new BVH helper)
        // Transform radius to local space (approximate)
        const scale = Math.max(this.ecs.store.scaleX[idx], this.ecs.store.scaleY[idx]);
        const localRadius = (this.softSelectionRadius * 0.5) / scale; // Use half soft-sel radius as brush size

        const vertices = MeshTopologyUtils.getVerticesInWorldSphere(
            asset.topology, 
            asset.geometry.vertices, 
            pick.worldPos, // pickMeshComponent returns local pos effectively
            localRadius
        );

        // 3. Update Selection
        if (add) {
            vertices.forEach(v => this.subSelection.vertexIds.add(v));
        } else {
            vertices.forEach(v => this.subSelection.vertexIds.delete(v));
        }
        
        this.recalculateSoftSelection();
        this.notifyUI();
    }

    executeAssetGraph(entityId: string, assetId: string) {
        // Placeholder for graph execution
    }

    // Mesh Ops
    extrudeFaces() { consoleService.warn('Extrude Faces: Not implemented'); }
    bevelEdges() { consoleService.warn('Bevel Edges: Not implemented'); }
    weldVertices() { consoleService.warn('Weld Vertices: Not implemented'); }
    connectComponents() { consoleService.warn('Connect Components: Not implemented'); }
    deleteSelectedFaces() { consoleService.warn('Delete Selected Faces: Not implemented'); }
}

export const engineInstance = new Engine();
