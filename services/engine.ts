
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
import { AnimationSystem } from './systems/AnimationSystem';
import { controlRigSystem } from './systems/ControlRigSystem'; 
import { COMPONENT_MASKS } from './constants';
import { eventBus } from './EventBus';
import { SelectionSystem } from './systems/SelectionSystem';

export type SoftSelectionMode = 'DYNAMIC' | 'FIXED';

export class Engine {
    ecs: SoAEntitySystem;
    sceneGraph: SceneGraph;
    physicsSystem: PhysicsSystem;
    historySystem: HistorySystem;
    particleSystem: ParticleSystem; 
    animationSystem: AnimationSystem; 
    selectionSystem: SelectionSystem;
    renderer: WebGLRenderer;
    debugRenderer: DebugRenderer;
    metrics: PerformanceMetrics;
    isPlaying: boolean = false;
    simulationMode: SimulationMode = 'STOPPED';
    renderMode: number = 0;
    
    meshComponentMode: MeshComponentMode = 'OBJECT';
    
    isInputDown: boolean = false;

    // Vertex Editing State (Added to fix errors)
    vertexSnapshot: Float32Array | null = null;
    activeDeformationEntity: string | null = null;
    currentDeformationDelta: Vector3 = { x: 0, y: 0, z: 0 };

    // Soft Selection State
    softSelectionEnabled: boolean = false;
    softSelectionRadius: number = 2.0;
    softSelectionMode: SoftSelectionMode = 'FIXED';
    softSelectionFalloff: SoftSelectionFalloff = 'VOLUME'; 
    softSelectionHeatmapVisible: boolean = true;
    
    // Cached weights for the current selection
    softSelectionWeights: Map<number, Float32Array> = new Map();
    
    // Map of Mesh Entity ID -> Array of Bone Entity IDs
    skeletonMap: Map<string, string[]> = new Map();

    uiConfig: UIConfiguration = DEFAULT_UI_CONFIG;

    timeline: TimelineState = {
        currentTime: 0,
        duration: 30,
        isPlaying: false,
        playbackSpeed: 1.0,
        isLooping: true
    };

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
        this.particleSystem = new ParticleSystem(); 
        this.animationSystem = new AnimationSystem();
        this.selectionSystem = new SelectionSystem(this);
        this.renderer = new WebGLRenderer();
        this.debugRenderer = new DebugRenderer();
        this.metrics = { fps: 0, frameTime: 0, drawCalls: 0, triangleCount: 0, entityCount: 0 };
        
        (window as any).engineInstance = this;

        registerCoreModules(this.physicsSystem, this.particleSystem, this.animationSystem);
        
        moduleManager.init({
            engine: this,
            ecs: this.ecs,
            scene: this.sceneGraph
        });

        this.initEventListeners();
    }

    // Added to fix errors in SceneView.tsx
    updateCamera(vp: Float32Array, pos: {x:number, y:number, z:number}, width: number, height: number) {
        this.currentViewProj = vp;
        this.currentCameraPos = pos;
        this.currentWidth = width;
        this.currentHeight = height;
    }

    // Added to fix errors in usePieMenuInteraction.ts
    extrudeFaces() { consoleService.info("Extrude Faces (Not Implemented)", "Engine"); }
    bevelEdges() { consoleService.info("Bevel Edges (Not Implemented)", "Engine"); }
    weldVertices() { consoleService.info("Weld Vertices (Not Implemented)", "Engine"); }
    connectComponents() { consoleService.info("Connect Components (Not Implemented)", "Engine"); }
    deleteSelectedFaces() { consoleService.info("Delete Faces (Not Implemented)", "Engine"); }

    private initEventListeners() {
        eventBus.on('ASSET_CREATED', (payload) => {
             const asset = assetManager.getAsset(payload.id);
             if (asset && (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH')) {
                 this.registerAssetWithGPU(asset);
             }
        });

        eventBus.on('ASSET_UPDATED', (payload) => {
            const asset = assetManager.getAsset(payload.id);
            if (asset && (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH')) {
                this.notifyMeshChanged(payload.id);
            } else if (asset && asset.type === 'MATERIAL') {
                this.compileGraph(asset.data.nodes, asset.data.connections, asset.id);
            }
        });
    }

    get meshSystem(): MeshRenderSystem {
        return this.renderer.meshSystem;
    }

    get hoveredVertex() { return this.selectionSystem.hoveredVertex; }
    setSelected(ids: string[]) { this.selectionSystem.setSelected(ids); }
    selectEntityAt(mx: number, my: number, w: number, h: number) { return this.selectionSystem.selectEntityAt(mx, my, w, h); }
    selectEntitiesInRect(x: number, y: number, w: number, h: number) { return this.selectionSystem.selectEntitiesInRect(x, y, w, h); }
    highlightVertexAt(mx: number, my: number, w: number, h: number) { this.selectionSystem.highlightVertexAt(mx, my, w, h); }
    selectVerticesInBrush(mx: number, my: number, w: number, h: number, add: boolean) { this.selectionSystem.selectVerticesInBrush(mx, my, w, h, add); }
    selectLoop(mode: MeshComponentMode) { this.selectionSystem.selectLoop(mode); }
    getSelectionAsVertices() { return this.selectionSystem.getSelectionAsVertices(); }

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
                this.meshSystem.registerMesh(intId, (asset as StaticMeshAsset).geometry);
            }
        }
    }

    notifyMeshChanged(assetId: string) {
        const intId = assetManager.getMeshID(assetId);
        if (intId > 0) {
            if (this.softSelectionWeights.has(intId)) {
                this.softSelectionWeights.delete(intId);
            }
            const asset = assetManager.getAsset(assetId) as StaticMeshAsset;
            if (asset) {
                this.updateMeshBounds(asset); 
            }
            this.registerAssetWithGPU(asset);
        }
    }

    private updateMeshBounds(asset: StaticMeshAsset) {
        // Simple AABB re-compute
        const verts = asset.geometry.vertices;
        let minX=Infinity, minY=Infinity, minZ=Infinity, maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
        for(let i=0; i<verts.length; i+=3) {
            const x = verts[i], y = verts[i+1], z = verts[i+2];
            if(x<minX) minX=x; if(y<minY) minY=y; if(z<minZ) minZ=z;
            if(x>maxX) maxX=x; if(y>maxY) maxY=y; if(z>maxZ) maxZ=z;
        }
        asset.geometry.aabb = { min: {x:minX, y:minY, z:minZ}, max: {x:maxX, y:maxY, z:maxZ} };
    }

    initGL(canvas: HTMLCanvasElement) {
        this.renderer.init(canvas);
        this.renderer.initGizmo();
        this.debugRenderer.init(this.renderer.gl!);
        
        if (this.renderer.gl) {
             moduleManager.init({
                engine: this,
                ecs: this.ecs,
                scene: this.sceneGraph,
                gl: this.renderer.gl
            });
        }

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

    executeAssetGraph(id: string, assetId: string) {
        controlRigSystem.getOrCreateRigInstance(id, assetId);
    }

    createEntityFromAsset(assetId: string, pos: {x:number, y:number, z:number}) {
        let asset = assetManager.getAsset(assetId);
        
        if (!asset && assetId.startsWith('SM_')) {
            const primName = assetId.replace('SM_', '');
            const meshes = assetManager.getAssetsByType('MESH');
            asset = meshes.find(a => a.name === `SM_${primName}`);
        }

        if (!asset) {
            consoleService.warn(`[Engine] Could not find asset: ${assetId}`);
            return null;
        }

        const id = this.ecs.createEntity(asset.name);
        const idx = this.ecs.idToIndex.get(id);
        
        if (idx !== undefined) {
            this.ecs.store.setPosition(idx, pos.x, pos.y, pos.z);
            
            if (asset.type === 'MESH') {
                this.ecs.addComponent(id, ComponentType.MESH);
                this.ecs.store.meshType[idx] = assetManager.getMeshID(asset.id);
                if (this.ecs.store.materialIndex[idx] === 0) this.ecs.store.materialIndex[idx] = 1; 
            } 
            else if (asset.type === 'SKELETAL_MESH') {
                this.ecs.addComponent(id, ComponentType.MESH);
                this.ecs.store.meshType[idx] = assetManager.getMeshID(asset.id);
                if (this.ecs.store.materialIndex[idx] === 0) this.ecs.store.materialIndex[idx] = 1; 
                
                const skelAsset = asset as SkeletalMeshAsset;
                const bones = skelAsset.skeleton.bones;
                const boneEntityIds: string[] = new Array(bones.length);

                bones.forEach((bone, bIdx) => {
                    const boneId = this.ecs.createEntity(bone.name);
                    const bEcsIdx = this.ecs.idToIndex.get(boneId)!;
                    
                    if (bone.parentIndex !== -1) {
                        const parentId = boneEntityIds[bone.parentIndex];
                        if (parentId) this.sceneGraph.attach(boneId, parentId);
                    } else {
                        this.sceneGraph.attach(boneId, id);
                    }
                    
                    boneEntityIds[bIdx] = boneId;
                    this.sceneGraph.registerEntity(boneId);
                    this.ecs.addComponent(boneId, ComponentType.VIRTUAL_PIVOT);
                    this.ecs.store.vpLength[bEcsIdx] = 0.2;
                });
                
                this.skeletonMap.set(id, boneEntityIds);
            }
            
            this.sceneGraph.registerEntity(id);
            this.notifyUI();
            this.pushUndoState();
        }
        return id;
    }

    deleteEntity(id: string, sceneGraph: SceneGraph) {
        this.pushUndoState();
        if (this.skeletonMap.has(id)) {
            const bones = this.skeletonMap.get(id)!;
            bones.forEach(bId => this.ecs.deleteEntity(bId, sceneGraph));
            this.skeletonMap.delete(id);
        }
        this.ecs.deleteEntity(id, sceneGraph);
        this.notifyUI();
    }

    duplicateEntity(id: string) {
        const idx = this.ecs.idToIndex.get(id);
        if (idx === undefined) return;
        
        this.pushUndoState();
        const newId = this.ecs.createEntity(this.ecs.store.names[idx] + " (Copy)");
        const newIdx = this.ecs.idToIndex.get(newId)!;
        
        const store = this.ecs.store;
        store.componentMask[newIdx] = store.componentMask[idx];
        
        store.posX[newIdx] = store.posX[idx]; store.posY[newIdx] = store.posY[idx]; store.posZ[newIdx] = store.posZ[idx];
        store.rotX[newIdx] = store.rotX[idx]; store.rotY[newIdx] = store.rotY[idx]; store.rotZ[newIdx] = store.rotZ[idx];
        store.scaleX[newIdx] = store.scaleX[idx]; store.scaleY[newIdx] = store.scaleY[idx]; store.scaleZ[newIdx] = store.scaleZ[idx];
        
        store.meshType[newIdx] = store.meshType[idx];
        store.materialIndex[newIdx] = store.materialIndex[idx];
        
        this.sceneGraph.registerEntity(newId);
        this.notifyUI();
        consoleService.info(`Duplicated entity: ${id} -> ${newId}`);
    }

    saveScene(): string { return this.ecs.serialize(); }
    loadScene(json: string) { this.ecs.deserialize(json, this.sceneGraph); this.notifyUI(); }
    getPostProcessConfig() { return this.renderer.ppConfig; }
    setPostProcessConfig(config: PostProcessConfig) { this.renderer.ppConfig = config; this.renderer.recompilePostProcess(); this.notifyUI(); }
    setRenderMode(mode: number) { this.renderer.renderMode = mode; this.notifyUI(); }
    toggleGrid() { this.renderer.showGrid = !this.renderer.showGrid; this.notifyUI(); }
    syncTransforms() { this.sceneGraph.update(); this.notifyUI(); }

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

    tick(dt: number) {
        if (this.simulationMode !== 'STOPPED' && this.isPlaying) {
            this.accumulator += dt;
            while(this.accumulator >= this.fixedTimeStep) {
                this.physicsSystem.update(this.fixedTimeStep, this.ecs.store, this.ecs.idToIndex, this.sceneGraph);
                this.accumulator -= this.fixedTimeStep;
            }
        }

        if (this.timeline.isPlaying) {
            this.timeline.currentTime += dt * this.timeline.playbackSpeed;
            if (this.timeline.currentTime >= this.timeline.duration) {
                if (this.timeline.isLooping) this.timeline.currentTime = 0;
                else {
                    this.timeline.currentTime = this.timeline.duration;
                    this.timeline.isPlaying = false;
                }
            }
        }

        this.particleSystem.update(dt, this.ecs.store);
        
        // Control Rig & Animation
        controlRigSystem.update(dt);
        this.animationSystem.update(
            dt, 
            this.timeline.currentTime,
            this.timeline.isPlaying,
            this.skeletonMap, 
            this.meshSystem, 
            this.ecs, 
            this.sceneGraph,
            this.debugRenderer, 
            this.selectionSystem.selectedIndices,
            this.meshComponentMode
        );

        moduleManager.update(dt);
        this.sceneGraph.update();
        
        this.metrics.fps = 1.0 / Math.max(dt, 0.001);
        this.metrics.frameTime = dt * 1000;
        this.metrics.entityCount = this.ecs.count;
        this.metrics.drawCalls = this.renderer.drawCalls;
        
        if (this.renderer.gl && this.currentViewProj) {
            this.renderer.render(
                this.ecs.store, 
                this.ecs.count, 
                this.selectionSystem.selectedIndices, 
                this.currentViewProj, 
                this.currentWidth, 
                this.currentHeight, 
                this.currentCameraPos,
                { enabled: this.softSelectionEnabled, center: {x:0,y:0,z:0}, radius: this.softSelectionRadius, heatmapVisible: this.softSelectionHeatmapVisible },
                this.debugRenderer,
                this.particleSystem
            );
        }
        
        this.debugRenderer.begin();
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

        const selectedVerts = this.selectionSystem.getSelectionAsVertices();
        const hasSelection = selectedVerts.size > 0;

        const inRange: {idx: number, dist: number, strength: number}[] = [];
        let sumWeights = 0;
        
        for (let i = 0; i < count; i++) {
            if (hasSelection && !selectedVerts.has(i)) continue; 

            const vx = verts[i*3], vy = verts[i*3+1], vz = verts[i*3+2];
            const wx = worldMat[0]*vx + worldMat[4]*vy + worldMat[8]*vz + worldMat[12];
            const wy = worldMat[1]*vx + worldMat[5]*vy + worldMat[9]*vz + worldMat[13];
            const wz = worldMat[2]*vx + worldMat[6]*vy + worldMat[10]*vz + worldMat[14];
            
            const dist = Math.sqrt((wx - worldPos.x)**2 + (wy - worldPos.y)**2 + (wz - worldPos.z)**2);
            
            if (dist <= radius) {
                const falloff = Math.pow(1.0 - (dist / radius), 2);
                const strength = weight * falloff;
                inRange.push({idx: i, dist, strength});
                
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
                jointWeights[i*4+slot] = MathUtils.lerp(currentW, avgWeight, strength * 0.5);
            }

            let sum = 0;
            for(let k=0; k<4; k++) sum += jointWeights[i*4+k];
            if (sum > 0) {
                const scale = 1.0 / sum;
                for(let k=0; k<4; k++) jointWeights[i*4+k] *= scale;
            } else {
                jointWeights[i*4] = 1.0;
            }
            
            modified = true;
        }

        if (modified) {
            eventBus.emit('ASSET_UPDATED', { id: asset.id, type: asset.type });
        }
    }

    floodSkinWeights(entityId: string, boneIndex: number, value: number) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const asset = assetManager.getAsset(assetManager.meshIntToUuid.get(this.ecs.store.meshType[idx])!) as SkeletalMeshAsset;
        if(!asset || asset.type !== 'SKELETAL_MESH') return;

        const count = asset.geometry.vertices.length / 3;
        
        const selectedVerts = this.selectionSystem.getSelectionAsVertices();
        const hasSelection = selectedVerts.size > 0;

        for (let i = 0; i < count; i++) {
            if (hasSelection && !selectedVerts.has(i)) continue;
            
            const jointIndices = asset.geometry.jointIndices;
            const jointWeights = asset.geometry.jointWeights;
            
            // For flood, we replace everything for this bone
            let slot = -1;
            for(let k=0; k<4; k++) if(jointIndices[i*4+k] === boneIndex) slot = k;
            
            if (slot === -1) {
                // Find empty
                for(let k=0; k<4; k++) if(jointWeights[i*4+k] === 0) { slot = k; break; }
            }
            if (slot === -1) {
                // Steal smallest
                let minW = 2.0; let minK = 0;
                for(let k=0; k<4; k++) { if(jointWeights[i*4+k] < minW) { minW=jointWeights[i*4+k]; minK=k; } }
                slot = minK;
            }
            
            jointIndices[i*4+slot] = boneIndex;
            jointWeights[i*4+slot] = value;
            
            // Normalize
            let sum = 0;
            for(let k=0; k<4; k++) sum += jointWeights[i*4+k];
            if (sum > 0) {
                const scale = 1.0 / sum;
                for(let k=0; k<4; k++) jointWeights[i*4+k] *= scale;
            }
        }
        eventBus.emit('ASSET_UPDATED', { id: asset.id, type: asset.type });
    }

    pruneSkinWeights(entityId: string, threshold: number) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const asset = assetManager.getAsset(assetManager.meshIntToUuid.get(this.ecs.store.meshType[idx])!) as SkeletalMeshAsset;
        if(!asset || asset.type !== 'SKELETAL_MESH') return;

        const count = asset.geometry.vertices.length / 3;
        const jointWeights = asset.geometry.jointWeights;

        for (let i = 0; i < count; i++) {
            for(let k=0; k<4; k++) {
                if(jointWeights[i*4+k] < threshold) jointWeights[i*4+k] = 0;
            }
            // Normalize
            let sum = 0;
            for(let k=0; k<4; k++) sum += jointWeights[i*4+k];
            if (sum > 0) {
                const scale = 1.0 / sum;
                for(let k=0; k<4; k++) jointWeights[i*4+k] *= scale;
            }
        }
        eventBus.emit('ASSET_UPDATED', { id: asset.id, type: asset.type });
    }

    recalculateSoftSelection(trigger: boolean = true) {
        this.softSelectionWeights.clear();
        if (!this.softSelectionEnabled || this.meshComponentMode === 'OBJECT' || this.selectionSystem.selectedIndices.size === 0) {
            if (trigger) this.notifyUI();
            return;
        }

        const idx = Array.from(this.selectionSystem.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        
        if (!asset) return;

        const selection = this.selectionSystem.getSelectionAsVertices();
        const weights = MeshTopologyUtils.computeSurfaceWeights(
            asset.geometry.indices, 
            asset.geometry.vertices, 
            selection, 
            this.softSelectionRadius, 
            asset.geometry.vertices.length / 3
        );
        
        this.softSelectionWeights.set(meshIntId, weights);
        this.meshSystem.updateSoftSelectionBuffer(meshIntId, weights);
        if (trigger) this.notifyUI();
    }

    startVertexDrag(entityId: string) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const uuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(uuid!) as StaticMeshAsset;
        if (asset) {
            this.vertexSnapshot = new Float32Array(asset.geometry.vertices);
            this.activeDeformationEntity = entityId;
            this.currentDeformationDelta = { x:0, y:0, z:0 };
        }
    }

    updateVertexDrag(entityId: string, delta: Vector3) {
        if (!this.vertexSnapshot || this.activeDeformationEntity !== entityId) return;
        
        const idx = this.ecs.idToIndex.get(entityId);
        const meshIntId = this.ecs.store.meshType[idx!];
        const uuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(uuid!) as StaticMeshAsset;
        
        const weights = this.softSelectionWeights.get(meshIntId);
        const parentInverse = Mat4Utils.create();
        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (worldMat) Mat4Utils.invert(worldMat, parentInverse);
        
        // Transform global delta to local space
        const localDelta = { x: delta.x, y: delta.y, z: delta.z };
        // Ideally should transform delta by inverse rotation/scale, simplified here
        const invScaleX = 1.0 / this.ecs.store.scaleX[idx!];
        const invScaleY = 1.0 / this.ecs.store.scaleY[idx!];
        const invScaleZ = 1.0 / this.ecs.store.scaleZ[idx!];
        localDelta.x *= invScaleX; localDelta.y *= invScaleY; localDelta.z *= invScaleZ;

        const verts = asset.geometry.vertices;
        const count = verts.length / 3;
        
        const selection = this.selectionSystem.getSelectionAsVertices();
        const useSoft = this.softSelectionEnabled && weights;

        for(let i=0; i<count; i++) {
            let weight = 0;
            if (selection.has(i)) weight = 1.0;
            else if (useSoft) weight = weights![i];
            
            if (weight > 0) {
                verts[i*3] = this.vertexSnapshot[i*3] + localDelta.x * weight;
                verts[i*3+1] = this.vertexSnapshot[i*3+1] + localDelta.y * weight;
                verts[i*3+2] = this.vertexSnapshot[i*3+2] + localDelta.z * weight;
            }
        }
        
        this.registerAssetWithGPU(asset);
    }

    endVertexDrag() {
        this.vertexSnapshot = null;
        this.activeDeformationEntity = null;
    }

    clearDeformation() {
        this.vertexSnapshot = null;
    }
}

export const engineInstance = new Engine();