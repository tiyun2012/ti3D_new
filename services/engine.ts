
// services/engine.ts

import { SoAEntitySystem } from './ecs/EntitySystem';
import { SceneGraph } from './SceneGraph';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { HistorySystem } from './systems/HistorySystem';
import { WebGLRenderer, PostProcessConfig } from './renderers/WebGLRenderer';
import { DebugRenderer } from './renderers/DebugRenderer';
import { assetManager } from './AssetManager';
import { PerformanceMetrics, GraphNode, GraphConnection, ComponentType, TimelineState, MeshComponentMode, StaticMeshAsset, Asset, SimulationMode, Vector3 } from '../types';
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
    
    // New: Track hovered vertex for UI feedback
    hoveredVertex: { entityId: string, index: number } | null = null;
    isInputDown: boolean = false;

    // Soft Selection State
    softSelectionEnabled: boolean = false;
    softSelectionRadius: number = 2.0;

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
        this.renderer = new WebGLRenderer();
        this.debugRenderer = new DebugRenderer();
        this.metrics = { fps: 0, frameTime: 0, drawCalls: 0, triangleCount: 0, entityCount: 0 };
        
        // Initialize Modular System
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

    moveSelectedVertices(entityId: string, worldDelta: Vector3) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return;

        // 1. Transform World Delta to Local Delta
        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return;
        const invWorld = Mat4Utils.create();
        Mat4Utils.invert(worldMat, invWorld);
        
        // Transform the vector (direction), ignore translation
        const localDelta = Vec3Utils.transformMat4Normal(worldDelta, invWorld, {x:0,y:0,z:0});

        const vertexIds = Array.from(this.subSelection.vertexIds);
        if (vertexIds.length === 0) return;

        const verts = asset.geometry.vertices;
        const norms = asset.geometry.normals;

        if (this.softSelectionEnabled) {
            // Calculate Centroid of selection
            const centroid = {x:0, y:0, z:0};
            for(const vid of vertexIds) {
                centroid.x += verts[vid*3];
                centroid.y += verts[vid*3+1];
                centroid.z += verts[vid*3+2];
            }
            centroid.x /= vertexIds.length;
            centroid.y /= vertexIds.length;
            centroid.z /= vertexIds.length;

            // Iterate all vertices (Naive Approach)
            // Ideally use Spatial Hash or BVH, but for < 65k verts JS loop is okay-ish
            const radius = this.softSelectionRadius;
            
            // To properly handle radius in LOCAL space, we need to convert World Radius to Local Radius
            // Scale factor is roughly max scale axis
            const sx = this.ecs.store.scaleX[idx];
            const sy = this.ecs.store.scaleY[idx];
            const sz = this.ecs.store.scaleZ[idx];
            const maxScale = Math.max(sx, Math.max(sy, sz));
            const localRadius = radius / maxScale;

            for (let i=0; i<verts.length/3; i++) {
                const vx = verts[i*3], vy = verts[i*3+1], vz = verts[i*3+2];
                const dist = Math.sqrt((vx-centroid.x)**2 + (vy-centroid.y)**2 + (vz-centroid.z)**2);
                
                if (dist <= localRadius) {
                    // Falloff function (Smoothstep-ish)
                    const t = 1.0 - (dist / localRadius);
                    const weight = t * t * (3 - 2 * t);
                    
                    verts[i*3] += localDelta.x * weight;
                    verts[i*3+1] += localDelta.y * weight;
                    verts[i*3+2] += localDelta.z * weight;
                }
            }
        } else {
            // Hard Selection
            for (const vIdx of vertexIds) {
                verts[vIdx*3] += localDelta.x;
                verts[vIdx*3+1] += localDelta.y;
                verts[vIdx*3+2] += localDelta.z;
            }
        }

        // Re-upload
        this.registerAssetWithGPU(asset);
        // Note: Normals are invalid after move. A real sculpting tool recalculates them.
        // For simplicity, we skip full normal recalc here as it's expensive per frame. 
    }

    private getSoftSelectionContext() {
        const enabled = this.softSelectionEnabled && this.meshComponentMode === 'VERTEX' && this.subSelection.vertexIds.size > 0;
        let center = { x: 0, y: 0, z: 0 };
        
        if (enabled && this.selectedIndices.size > 0) {
            // Calculate center of selection in World Space
            // Assume single object editing for vertex mode
            const idx = Array.from(this.selectedIndices)[0];
            const entityId = this.ecs.store.ids[idx];
            
            const meshIntId = this.ecs.store.meshType[idx];
            const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
            if (assetUuid) {
                const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
                if (asset) {
                    const worldMat = this.sceneGraph.getWorldMatrix(entityId);
                    if (worldMat) {
                        const verts = asset.geometry.vertices;
                        const vIds = Array.from(this.subSelection.vertexIds);
                        
                        let cx = 0, cy = 0, cz = 0;
                        for (const vId of vIds) {
                            const vx = verts[vId*3], vy = verts[vId*3+1], vz = verts[vId*3+2];
                            // Transform to World
                            cx += worldMat[0]*vx + worldMat[4]*vy + worldMat[8]*vz + worldMat[12];
                            cy += worldMat[1]*vx + worldMat[5]*vy + worldMat[9]*vz + worldMat[13];
                            cz += worldMat[2]*vx + worldMat[6]*vy + worldMat[10]*vz + worldMat[14];
                        }
                        const invLen = 1.0 / vIds.length;
                        center = { x: cx * invLen, y: cy * invLen, z: cz * invLen };
                    }
                }
            }
        }
        
        return { enabled, center, radius: this.softSelectionRadius };
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

            // Run Module Updates
            moduleManager.update(dt);

            if (this.currentViewProj && !this.isPlaying) {
                // Clear debug lines at start of frame
                this.debugRenderer.begin();
            }

            if (this.currentViewProj) {
                const softSel = this.getSoftSelectionContext();
                
                this.renderer.render(
                    this.ecs.store, 
                    this.ecs.count, 
                    this.selectedIndices, 
                    this.currentViewProj, 
                    this.currentWidth, 
                    this.currentHeight, 
                    this.currentCameraPos,
                    softSel,
                    this.isPlaying && this.simulationMode === 'GAME' ? undefined : this.debugRenderer
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
        this.selectedIndices.clear();
        ids.forEach(id => {
            const idx = this.ecs.idToIndex.get(id);
            if (idx !== undefined) this.selectedIndices.add(idx);
        });
        // We do NOT clear subSelection immediately if switching mode, but here we likely selected new objects
        // If IDs changed, clear sub selection
        // For now, keep it simple: always clear sub-sel on object change
        this.subSelection.vertexIds.clear(); this.subSelection.edgeIds.clear(); this.subSelection.faceIds.clear();
        this.hoveredVertex = null;
    }

    highlightVertexAt(mx: number, my: number, w: number, h: number) {
        if (this.meshComponentMode !== 'VERTEX' || this.selectedIndices.size === 0 || !this.currentViewProj) {
            this.hoveredVertex = null;
            return;
        }

        // Only check vertices of the first selected object for now (performance)
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
        let minDistSq = 20 * 20; // 20px radius
        let closest = -1;

        // Skip heavy iteration if too many vertices? 
        // For now, assume < 100k verts is acceptable in JS loop for hover
        
        for (let i = 0; i < verts.length / 3; i++) {
            const x = verts[i*3], y = verts[i*3+1], z = verts[i*3+2];
            
            // Project
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
            if (internalId > 0) this.meshSystem.registerMesh(internalId, asset.geometry);
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
}

export const engineInstance = new Engine();
(window as any).engineInstance = engineInstance;
