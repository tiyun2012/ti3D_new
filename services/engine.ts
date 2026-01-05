
import { SoAEntitySystem } from './ecs/EntitySystem';
import { SceneGraph } from './SceneGraph';
import { SelectionSystem } from './systems/SelectionSystem';
import { MeshRenderSystem } from './systems/MeshRenderSystem';
import { WebGLRenderer } from './renderers/WebGLRenderer';
import { DebugRenderer } from './renderers/DebugRenderer';
import { TimelineSystem } from './systems/TimelineSystem';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { ParticleSystem } from './systems/ParticleSystem';
import { AnimationSystem } from './systems/AnimationSystem';
import { HistorySystem } from './systems/HistorySystem';
import { controlRigSystem } from './systems/ControlRigSystem';
import { PerformanceMetrics, ComponentType, SimulationMode, MeshComponentMode, SoftSelectionFalloff, Vector3 } from '../types';
import { assetManager } from './AssetManager';
import { registerCoreModules } from './modules/CoreModules';
import { moduleManager } from './ModuleManager';
import { consoleService } from './Console';
import { GridConfiguration, UIConfiguration } from '../contexts/EditorContext';
import { MeshTopologyUtils } from './MeshTopologyUtils';

export type SoftSelectionMode = 'FIXED' | 'DYNAMIC';

export class Engine {
    ecs: SoAEntitySystem;
    sceneGraph: SceneGraph;
    selectionSystem: SelectionSystem;
    
    // Sub-Systems
    meshSystem: MeshRenderSystem;
    physicsSystem: PhysicsSystem;
    particleSystem: ParticleSystem;
    animSystem: AnimationSystem;
    historySystem: HistorySystem;
    
    renderer: WebGLRenderer;
    debugRenderer: DebugRenderer;
    timeline: TimelineSystem;
    
    metrics: PerformanceMetrics = { fps: 0, frameTime: 0, drawCalls: 0, triangleCount: 0, entityCount: 0 };
    
    simulationMode: SimulationMode = 'STOPPED';
    meshComponentMode: MeshComponentMode = 'OBJECT';
    
    currentViewProj: Float32Array | null = null;
    currentCameraPos = { x: 0, y: 0, z: 0 };
    currentWidth = 800;
    currentHeight = 600;
    
    softSelectionEnabled = false;
    softSelectionRadius = 2.0;
    softSelectionMode: SoftSelectionMode = 'FIXED';
    softSelectionFalloff: SoftSelectionFalloff = 'VOLUME';
    softSelectionHeatmapVisible = true;
    
    isInputDown = false;
    currentShaderSource = '';
    skeletonMap = new Map<string, string[]>(); // EntityId -> Bone Entity Ids

    gridConfig: GridConfiguration | null = null;
    uiConfig: UIConfiguration = {
        windowBorderRadius: 8,
        resizeHandleThickness: 6,
        resizeHandleColor: '#4f80f8',
        resizeHandleOpacity: 0.2,
        resizeHandleLength: 1.0,
        selectionEdgeHighlight: true,
        selectionEdgeColor: '#4f80f8',
        vertexSize: 1.0,
        vertexColor: '#a855f7'
    };

    private listeners: (() => void)[] = [];

    constructor() {
        this.ecs = new SoAEntitySystem();
        this.sceneGraph = new SceneGraph();
        this.sceneGraph.setContext(this.ecs);
        
        this.renderer = new WebGLRenderer();
        this.debugRenderer = new DebugRenderer();
        this.timeline = new TimelineSystem();
        
        this.meshSystem = this.renderer.meshSystem;
        this.physicsSystem = new PhysicsSystem();
        this.particleSystem = new ParticleSystem();
        this.animSystem = new AnimationSystem();
        this.historySystem = new HistorySystem();
        
        this.selectionSystem = new SelectionSystem(this as any);
        
        registerCoreModules(this.physicsSystem, this.particleSystem, this.animSystem);
    }

    initGL(canvas: HTMLCanvasElement) {
        this.renderer.init(canvas);
        const gl = this.renderer.gl;
        if (gl) {
            this.debugRenderer.init(gl);
            this.particleSystem.init(gl);
            moduleManager.init({ engine: this, ecs: this.ecs, scene: this.sceneGraph, gl });
        }
        
        // Load default scene after init
        this.createDefaultScene();
    }

    resize(width: number, height: number) {
        this.currentWidth = width;
        this.currentHeight = height;
        this.renderer.resize(width, height);
        this.notifyUI();
    }

    start(mode: SimulationMode) {
        if (this.simulationMode !== 'STOPPED') return;
        this.pushUndoState();
        this.simulationMode = mode;
        this.timeline.play();
        this.notifyUI();
    }

    stop() {
        if (this.simulationMode === 'STOPPED') return;
        this.simulationMode = 'STOPPED';
        this.timeline.stop();
        // Restore state
        this.historySystem.undo(this.ecs, this.sceneGraph); 
        this.notifyUI();
    }

    updateCamera(vp: Float32Array, pos: { x: number, y: number, z: number }, w: number, h: number) {
        this.currentViewProj = vp;
        this.currentCameraPos = pos;
        this.currentWidth = w;
        this.currentHeight = h;
    }

    tick(dt: number) {
        const start = performance.now();
        
        // Systems Update
        moduleManager.update(dt);
        
        // Physics (only if simulating)
        if (this.simulationMode !== 'STOPPED') {
            // physicsSystem update called via moduleManager adapter
        }
        
        // Timeline
        if (this.timeline.update(dt)) {
            // Loop handled in timeline system
        }
        
        // Control Rig
        controlRigSystem.update(dt);
        
        // Scene Graph (Transform Hierarchy)
        this.sceneGraph.update();
        
        // Render
        if (this.currentViewProj) {
            this.debugRenderer.begin();
            
            // Pass soft selection info to renderer
            const softSelData = {
                enabled: this.softSelectionEnabled && this.meshComponentMode !== 'OBJECT',
                center: { x: 0, y: 0, z: 0 }, // Not used by renderer currently (uses weights buffer)
                radius: this.softSelectionRadius,
                heatmapVisible: this.softSelectionHeatmapVisible
            };

            this.renderer.render(
                this.ecs.store, 
                this.ecs.count, 
                this.selectionSystem.selectedIndices, 
                this.currentViewProj, 
                this.currentWidth, 
                this.currentHeight, 
                this.currentCameraPos, 
                softSelData,
                this.debugRenderer,
                this.particleSystem
            );
        }

        const end = performance.now();
        this.metrics.frameTime = end - start;
        this.metrics.fps = 1000 / Math.max(1, this.metrics.frameTime);
        this.metrics.entityCount = this.ecs.count;
        this.metrics.drawCalls = this.renderer.drawCalls;
    }

    // --- State Management ---

    subscribe(cb: () => void) {
        this.listeners.push(cb);
        return () => { this.listeners = this.listeners.filter(l => l !== cb); };
    }

    notifyUI() {
        this.listeners.forEach(cb => cb());
    }

    pushUndoState() {
        this.historySystem.pushState(this.ecs);
    }

    // --- Tools & Actions ---

    createEntityFromAsset(assetId: string, pos: { x: number, y: number, z: number }): string | null {
        const asset = assetManager.getAsset(assetId) || assetManager.getAllAssets().find(a => a.name === assetId);
        if (!asset) return null;

        const entityId = this.ecs.createEntity(asset.name);
        const idx = this.ecs.idToIndex.get(entityId)!;
        this.ecs.store.setPosition(idx, pos.x, pos.y, pos.z);
        this.sceneGraph.registerEntity(entityId);

        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            this.ecs.addComponent(entityId, ComponentType.MESH);
            const meshIntId = assetManager.getMeshID(asset.id);
            this.ecs.store.meshType[idx] = meshIntId;
            
            // LAZY REGISTRATION: Ensure mesh is on GPU if it hasn't been registered yet
            if (this.renderer.gl && !this.meshSystem.meshes.has(meshIntId)) {
                this.registerAssetWithGPU(asset);
            }

            if (asset.type === 'SKELETAL_MESH') {
                // Skeleton setup logic if needed
            }
        }
        
        this.notifyUI();
        return entityId;
    }

    deleteEntity(id: string, sg: SceneGraph) {
        this.pushUndoState();
        this.ecs.deleteEntity(id, sg);
        this.notifyUI();
    }

    duplicateEntity(id: string) {
        this.pushUndoState();
        // Simplified duplication
        const idx = this.ecs.idToIndex.get(id);
        if (idx !== undefined) {
            const name = this.ecs.store.names[idx] + " (Copy)";
            const newId = this.ecs.createEntity(name);
            const newIdx = this.ecs.idToIndex.get(newId)!;
            
            // Copy components
            this.ecs.store.componentMask[newIdx] = this.ecs.store.componentMask[idx];
            
            // Copy Transform
            this.ecs.store.setPosition(newIdx, this.ecs.store.posX[idx], this.ecs.store.posY[idx], this.ecs.store.posZ[idx]);
            this.ecs.store.setRotation(newIdx, this.ecs.store.rotX[idx], this.ecs.store.rotY[idx], this.ecs.store.rotZ[idx]);
            this.ecs.store.setScale(newIdx, this.ecs.store.scaleX[idx], this.ecs.store.scaleY[idx], this.ecs.store.scaleZ[idx]);
            
            // Copy Mesh
            this.ecs.store.meshType[newIdx] = this.ecs.store.meshType[idx];
            this.ecs.store.materialIndex[newIdx] = this.ecs.store.materialIndex[idx];
            
            this.sceneGraph.registerEntity(newId);
            this.selectionSystem.setSelected([newId]);
        }
        this.notifyUI();
    }

    get renderMode() {
        return this.renderer.renderMode;
    }

    setRenderMode(mode: number) {
        this.renderer.renderMode = mode;
        this.notifyUI();
    }

    toggleGrid() {
        if (this.gridConfig) {
            this.gridConfig.visible = !this.gridConfig.visible;
            this.setGridConfig(this.gridConfig);
            this.notifyUI();
        }
    }

    setGridConfig(config: GridConfiguration) {
        this.gridConfig = config;
        this.renderer.showGrid = config.visible;
        this.renderer.gridSize = config.size;
        this.renderer.gridSubdivisions = config.subdivisions;
        this.renderer.gridOpacity = config.opacity;
        this.renderer.gridFadeDistance = config.fadeDistance;
        this.renderer.gridExcludePP = config.excludeFromPostProcess;
        // Parse color
        if(config.color.startsWith('#')) {
            const r = parseInt(config.color.slice(1,3), 16)/255;
            const g = parseInt(config.color.slice(3,5), 16)/255;
            const b = parseInt(config.color.slice(5,7), 16)/255;
            this.renderer.gridColor = [r,g,b];
        }
    }

    setUiConfig(config: UIConfiguration) {
        this.uiConfig = config;
        this.notifyUI();
    }

    setPostProcessConfig(config: any) {
        this.renderer.ppConfig = config;
    }
    
    getPostProcessConfig() {
        return this.renderer.ppConfig;
    }

    recalculateSoftSelection(trigger = false) {
        if (!this.softSelectionEnabled || this.meshComponentMode === 'OBJECT') return;
        
        const selectedIndices = this.selectionSystem.getSelectionAsVertices();
        
        // For demonstration, assume single selected object
        if (this.selectionSystem.selectedIndices.size === 0) return;
        
        const idx = Array.from(this.selectionSystem.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as any; // StaticMeshAsset
        
        if (!asset) return;
        
        // Calculate Weights
        let weights: Float32Array;
        const vertexCount = asset.geometry.vertices.length / 3;
        
        if (this.softSelectionFalloff === 'SURFACE' && asset.topology) {
             // Topological Distance (Geodesic approximation via Dijkstra)
             if (asset.geometry.indices) {
                 weights = MeshTopologyUtils.computeSurfaceWeights(
                     asset.geometry.indices,
                     asset.geometry.vertices,
                     selectedIndices,
                     this.softSelectionRadius,
                     vertexCount
                 );
             } else {
                 weights = new Float32Array(vertexCount).fill(0);
             }
        } else {
             // Volume Distance (Euclidean)
             weights = new Float32Array(vertexCount);
             // Basic implementation for volume falloff
             const verts = asset.geometry.vertices;
             selectedIndices.forEach(selIdx => {
                 const px = verts[selIdx*3];
                 const py = verts[selIdx*3+1];
                 const pz = verts[selIdx*3+2];
                 
                 for(let i=0; i<vertexCount; i++) {
                     if (weights[i] >= 1.0) continue;
                     const dx = verts[i*3] - px;
                     const dy = verts[i*3+1] - py;
                     const dz = verts[i*3+2] - pz;
                     const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
                     
                     if (dist <= this.softSelectionRadius) {
                         const w = 1.0 - (dist / this.softSelectionRadius);
                         // Smoothstep falloff
                         const smoothW = w * w * (3 - 2 * w);
                         weights[i] = Math.max(weights[i], smoothW);
                     }
                 }
             });
        }
        
        // Upload to GPU
        (this.renderer as any).updateSoftSelectionBuffer(meshIntId, weights);
        
        if(trigger) this.notifyUI();
    }

    clearDeformation() {
        // Reset vertex offsets if any
    }

    startVertexDrag(entityId: string) {
        // Store initial positions
    }

    updateVertexDrag(entityId: string, delta: Vector3) {
        // Apply delta * weight to vertices
    }

    endVertexDrag() {
        // Commit changes
    }

    // Mesh Ops
    extrudeFaces() {}
    bevelEdges() {}
    weldVertices() {}
    connectComponents() {}
    deleteSelectedFaces() {}
    
    // Skinning
    floodSkinWeights(entityId: string, boneIndex: number, value: number) {}
    pruneSkinWeights(entityId: string, threshold: number) {}
    paintSkinWeights(entityId: string, worldPos: Vector3, boneIndex: number, weight: number, mode: string, radius: number) {}
    
    syncTransforms() {
        this.sceneGraph.update();
    }

    // Serialization
    saveScene() {
        return this.ecs.serialize();
    }

    loadScene(json: string) {
        this.ecs.deserialize(json, this.sceneGraph);
        this.notifyUI();
    }

    registerAssetWithGPU(asset: any) {
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            const id = assetManager.getMeshID(asset.id);
            this.renderer.meshSystem.registerMesh(id, asset.geometry);
        }
    }

    compileGraph(nodes: any[], connections: any[], assetId: string) {
        // Placeholder for shader compilation triggering
        // In a real app, this would update material programs in renderer
        // this.renderer.meshSystem.updateMaterial(...)
    }

    private createDefaultScene() {
        const standardMat = assetManager.getAssetsByType('MATERIAL').find(a => a.name === 'Standard');
        
        const cubeId = this.createEntityFromAsset('SM_Cube', { x: -1.5, y: 0, z: 0 });
        if (cubeId && standardMat) {
            const idx = this.ecs.idToIndex.get(cubeId);
            if (idx !== undefined) {
                this.ecs.store.materialIndex[idx] = assetManager.getMaterialID(standardMat.id);
                this.ecs.store.effectIndex[idx] = 101; 
                this.ecs.store.names[idx] = "Holo Cube";
            }
        }

        const sphereId = this.createEntityFromAsset('SM_Sphere', { x: 1.5, y: 0, z: 0 });
        if (sphereId && standardMat) {
            const idx = this.ecs.idToIndex.get(sphereId);
            if (idx !== undefined) this.ecs.store.materialIndex[idx] = assetManager.getMaterialID(standardMat.id);
        }

        const fire = this.ecs.createEntity('Campfire Particles');
        this.ecs.addComponent(fire, ComponentType.TRANSFORM);
        this.ecs.addComponent(fire, ComponentType.PARTICLE_SYSTEM);
        const fireIdx = this.ecs.idToIndex.get(fire)!;
        this.ecs.store.setPosition(fireIdx, 0, 0, 0);
        this.sceneGraph.registerEntity(fire);
        
        const light = this.ecs.createEntity('Directional Light');
        this.ecs.addComponent(light, ComponentType.LIGHT);
        const idx = this.ecs.idToIndex.get(light)!;
        this.ecs.store.setPosition(idx, 5, 10, 5);
        this.ecs.store.setRotation(idx, -0.785, 0.785, 0); 
        this.sceneGraph.registerEntity(light);

        const pivot = this.ecs.createEntity('Virtual Pivot');
        this.ecs.addComponent(pivot, ComponentType.VIRTUAL_PIVOT);
        const pIdx = this.ecs.idToIndex.get(pivot)!;
        this.ecs.store.setPosition(pIdx, 0, 2, 0);
        this.sceneGraph.registerEntity(pivot);
        
        consoleService.success("Default Scene Created");
    }

    get isPlaying() {
        return this.timeline.isPlaying;
    }
    
    setTimelineTime(t: number) {
        this.timeline.setTime(t);
        this.notifyUI();
    }
}

export const engineInstance = new Engine();
