
import { SoAEntitySystem } from './ecs/EntitySystem';
import { SceneGraph } from './SceneGraph';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { HistorySystem } from './systems/HistorySystem';
import { WebGLRenderer, PostProcessConfig } from './renderers/WebGLRenderer';
import { DebugRenderer } from './renderers/DebugRenderer';
import { assetManager } from './AssetManager';
import { PerformanceMetrics, GraphNode, GraphConnection, ComponentType, MeshComponentMode, StaticMeshAsset, Asset, SimulationMode, Vector3, SoftSelectionFalloff, SkeletalMeshAsset } from '../types';
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
import { TimelineSystem } from './systems/TimelineSystem';

export type SoftSelectionMode = 'DYNAMIC' | 'FIXED';

interface VertexCache {
    indices: number[];
    originalPositions: Float32Array; // x,y,z per index
}

export class Engine {
    ecs: SoAEntitySystem;
    sceneGraph: SceneGraph;
    physicsSystem: PhysicsSystem;
    historySystem: HistorySystem;
    animationSystem: AnimationSystem;
    timelineSystem: TimelineSystem;
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
    private vertexSnapshot: VertexCache | null = null;
    private currentDeformationDelta: Vector3 = { x: 0, y: 0, z: 0 };
    private activeDeformationEntity: string | null = null;

    uiConfig: UIConfiguration = DEFAULT_UI_CONFIG;

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
        this.timelineSystem = new TimelineSystem();
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
        
        // Ensure all currently loaded assets are registered with the GPU
        assetManager.getAllAssets().forEach(asset => {
            if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
                const intId = assetManager.getMeshID(asset.id);
                if (intId) this.meshSystem.registerMesh(intId, (asset as StaticMeshAsset).geometry);
            }
        });

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
        this.timelineSystem.play();
        this.notifyUI(); 
        consoleService.info(mode === 'GAME' ? 'Game Started' : 'Simulation Started'); 
    }

    playTimelineOnly() {
        this.isPlaying = true;
        this.simulationMode = 'STOPPED'; // Do not run physics
        this.timelineSystem.play();
        this.notifyUI();
    }
    
    pause() { 
        this.timelineSystem.pause();
        this.isPlaying = false; 
        this.notifyUI(); 
        consoleService.info('Paused'); 
    }
    
    stop() { 
        this.isPlaying = false; 
        this.simulationMode = 'STOPPED';
        this.timelineSystem.stop();
        
        // Reset animation pose to time 0
        this.animationSystem.update(0, 0, this.meshSystem, this.ecs, this.sceneGraph);
        
        this.notifyUI(); 
        consoleService.info('Stopped'); 
    }
    
    setTimelineTime(time: number) { 
        this.timelineSystem.setTime(time); 
        // Manually update animation system for scrubbing when paused
        this.animationSystem.update(0, this.timelineSystem.state.currentTime, this.meshSystem, this.ecs, this.sceneGraph);
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

    paintSkinWeights(entityId: string, boneIndex: number, weight: number, mode: 'ADD'|'REPLACE'|'SMOOTH'|'REMOVE') {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as SkeletalMeshAsset;
        
        if (!asset || asset.type !== 'SKELETAL_MESH') return;
        
        const indices = asset.geometry.jointIndices;
        const weights = asset.geometry.jointWeights;
        
        const activeVerts = this.getSelectionAsVertices();
        const softWeights = this.softSelectionWeights.get(meshIntId);
        
        const selectionArray = Array.from(activeVerts);
        const brushVerts = this.softSelectionEnabled ? Array.from(softWeights?.keys() || []) : selectionArray;
        
        const loopCount = this.softSelectionEnabled && softWeights ? softWeights.length : selectionArray.length;

        for(let i=0; i<loopCount; i++) {
            const vIdx = this.softSelectionEnabled ? i : selectionArray[i];
            const influence = this.softSelectionEnabled && softWeights ? softWeights[i] : 1.0;
            
            if (influence <= 0.001) continue;

            const base = vIdx * 4;
            let w = [weights[base], weights[base+1], weights[base+2], weights[base+3]];
            let id = [indices[base], indices[base+1], indices[base+2], indices[base+3]];
            
            let slot = -1;
            for(let k=0; k<4; k++) if(id[k] === boneIndex) slot = k;
            
            if (slot === -1) {
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

            let sum = 0;
            for(let k=0; k<4; k++) sum += w[k];
            if (sum > 0) {
                const scale = 1.0 / sum;
                for(let k=0; k<4; k++) w[k] *= scale;
            }

            for(let k=0; k<4; k++) {
                indices[base+k] = id[k];
                weights[base+k] = w[k];
            }
        }
        
        this.registerAssetWithGPU(asset);
    }

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

    selectComponentsInRect(rectX: number, rectY: number, rectW: number, rectH: number, mode: MeshComponentMode, append: boolean) {
        if (!this.currentViewProj || this.selectedIndices.size === 0) return;

        if (!append) {
            this.subSelection.vertexIds.clear();
            this.subSelection.edgeIds.clear();
            this.subSelection.faceIds.clear();
        }

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

        for (const idx of this.selectedIndices) {
            const entityId = this.ecs.store.ids[idx];
            const meshIntId = this.ecs.store.meshType[idx];
            const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
            if (!assetUuid) continue;
            const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
            if (!asset) continue;

            const worldMat = this.sceneGraph.getWorldMatrix(entityId);
            if (!worldMat) continue;

            Mat4Utils.multiply(vp, worldMat, mvp);
            
            const verts = asset.geometry.vertices;
            const vertexCount = verts.length / 3;

            const m00 = mvp[0], m01 = mvp[1], m02 = mvp[2], m03 = mvp[3];
            const m10 = mvp[4], m11 = mvp[5], m12 = mvp[6], m13 = mvp[7];
            const m20 = mvp[8], m21 = mvp[9], m22 = mvp[10], m23 = mvp[11];
            const m30 = mvp[12], m31 = mvp[13], m32 = mvp[14], m33 = mvp[15];

            const checkPoint = (lx: number, ly: number, lz: number) => {
                const w = m03*lx + m13*ly + m23*lz + m33;
                if (w <= 0) return false; 
                
                const x = (m00*lx + m10*ly + m20*lz + m30) / w;
                const y = (m01*lx + m11*ly + m21*lz + m31) / w;
                
                const sx = (x + 1) * halfW;
                const sy = (1 - y) * halfH; 
                
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
                if (asset.topology && asset.topology.graph) {
                    asset.topology.graph.halfEdges.forEach(he => {
                        if (he.pair !== -1 && he.id > he.pair) return;
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
        const context = { ecs: this.ecs, sceneGraph: this.sceneGraph, entityId: entityId, time: this.timelineSystem.state.currentTime };
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

    // --- IMPLEMENTATION OF MISSING METHODS ---

    subscribe(cb: () => void) {
        this.listeners.push(cb);
        return () => {
            this.listeners = this.listeners.filter(l => l !== cb);
        };
    }

    notifyUI() {
        this.listeners.forEach(cb => cb());
    }

    setSelected(ids: string[]) {
        this.selectedIndices.clear();
        ids.forEach(id => {
            const idx = this.ecs.idToIndex.get(id);
            if (idx !== undefined) this.selectedIndices.add(idx);
        });
        this.notifyUI();
    }

    createEntityFromAsset(assetNameOrId: string, position: { x: number, y: number, z: number }) {
        let asset: Asset | undefined;
        // Try as ID first
        asset = assetManager.getAsset(assetNameOrId);
        // Try as Name if not found (for legacy/default calls)
        if (!asset) asset = assetManager.getAllAssets().find(a => a.name === assetNameOrId);
        
        if (!asset) {
            console.error(`Asset not found: ${assetNameOrId}`);
            return null;
        }

        const id = this.ecs.createEntity(asset.name);
        
        const idx = this.ecs.idToIndex.get(id)!;
        this.ecs.store.setPosition(idx, position.x, position.y, position.z);
        
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            this.ecs.addComponent(id, ComponentType.MESH);
            this.ecs.store.meshType[idx] = assetManager.getMeshID(asset.id);
        }
        
        if (asset.type === 'SKELETAL_MESH') {
            // Add Animation Component implicitly or logic
        }

        this.sceneGraph.registerEntity(id);
        this.pushUndoState();
        this.notifyUI();
        return id;
    }

    deleteEntity(id: string, sceneGraph: SceneGraph) {
        this.pushUndoState();
        this.ecs.deleteEntity(id, sceneGraph);
        this.selectedIndices.clear();
        this.subSelection.vertexIds.clear();
        this.subSelection.edgeIds.clear();
        this.subSelection.faceIds.clear();
        this.notifyUI();
    }

    duplicateEntity(id: string) {
        const idx = this.ecs.idToIndex.get(id);
        if (idx === undefined) return;
        
        this.pushUndoState();
        const name = this.ecs.store.names[idx] + " (Copy)";
        const newId = this.ecs.createEntity(name);
        const newIdx = this.ecs.idToIndex.get(newId)!;
        
        // Copy components
        this.ecs.store.componentMask[newIdx] = this.ecs.store.componentMask[idx];
        
        // Copy Transform (Offset slightly)
        this.ecs.store.posX[newIdx] = this.ecs.store.posX[idx] + 0.5;
        this.ecs.store.posY[newIdx] = this.ecs.store.posY[idx];
        this.ecs.store.posZ[newIdx] = this.ecs.store.posZ[idx] + 0.5;
        this.ecs.store.rotX[newIdx] = this.ecs.store.rotX[idx];
        this.ecs.store.rotY[newIdx] = this.ecs.store.rotY[idx];
        this.ecs.store.rotZ[newIdx] = this.ecs.store.rotZ[idx];
        this.ecs.store.scaleX[newIdx] = this.ecs.store.scaleX[idx];
        this.ecs.store.scaleY[newIdx] = this.ecs.store.scaleY[idx];
        this.ecs.store.scaleZ[newIdx] = this.ecs.store.scaleZ[idx];
        
        // Copy Mesh Data
        this.ecs.store.meshType[newIdx] = this.ecs.store.meshType[idx];
        this.ecs.store.materialIndex[newIdx] = this.ecs.store.materialIndex[idx];
        
        this.sceneGraph.registerEntity(newId);
        this.setSelected([newId]);
        this.notifyUI();
    }

    registerAssetWithGPU(asset: Asset) {
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            const intId = assetManager.getMeshID(asset.id);
            if (intId) this.meshSystem.registerMesh(intId, (asset as StaticMeshAsset).geometry);
        } else if (asset.type === 'MATERIAL') {
            // Trigger recompile
            this.recompileAllMaterials();
        }
        this.tick(0); // Force render update
    }

    pushUndoState() {
        this.historySystem.pushState(this.ecs);
    }

    updateCamera(vp: Float32Array, pos: {x:number, y:number, z:number}, w: number, h: number) {
        this.currentViewProj = vp;
        this.currentCameraPos = pos;
        this.currentWidth = w;
        this.currentHeight = h;
    }

    tick(dt: number) {
        const start = performance.now();
        const clampedDt = Math.min(dt, this.maxFrameTime);
        if (dt > 0 && this.isPlaying) {
            this.accumulator += clampedDt;
            while (this.accumulator >= this.fixedTimeStep) {
                this.fixedUpdate(this.fixedTimeStep);
                this.accumulator -= this.fixedTimeStep;
            }
        }
        
        this.sceneGraph.update();
        moduleManager.update(dt);
        
        this.debugRenderer.begin();
        
        if (this.currentViewProj) {
            const softSelData = { 
                enabled: this.softSelectionEnabled, 
                center: {x:0,y:0,z:0}, // Center computed in shader or unused for now
                radius: this.softSelectionRadius,
                heatmapVisible: this.softSelectionHeatmapVisible
            };
            
            this.renderer.render(
                this.ecs.store, 
                this.ecs.count, 
                this.selectedIndices, 
                this.currentViewProj, 
                this.currentWidth, 
                this.currentHeight, 
                this.currentCameraPos,
                softSelData,
                this.debugRenderer,
                this.selectedBoneIndex
            );
        }
        
        this.metrics.drawCalls = this.renderer.drawCalls;
        this.metrics.triangleCount = this.renderer.triangleCount;
        this.metrics.entityCount = this.ecs.count;
        this.metrics.fps = 1.0 / (dt || 0.016);
    }

    private fixedUpdate(fixedDt: number) {
        if (this.simulationMode !== 'STOPPED') {
            this.physicsSystem.update(fixedDt, this.ecs.store, this.ecs.idToIndex, this.sceneGraph);
        }
        
        // Update Timeline
        if (this.timelineSystem.update(fixedDt)) {
            this.notifyUI();
        }
        
        // Animation System (Runs at fixed 60Hz logic tick)
        this.animationSystem.update(fixedDt, this.timelineSystem.state.currentTime, this.meshSystem, this.ecs, this.sceneGraph);

        // Execute Asset Graphs
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

    recalculateSoftSelection() {
        if (!this.softSelectionEnabled || this.selectedIndices.size === 0 || this.meshComponentMode === 'OBJECT') {
            this.softSelectionWeights.clear();
            // Clear buffer on GPU
            const idx = Array.from(this.selectedIndices)[0];
            if(idx !== undefined) {
                const meshIntId = this.ecs.store.meshType[idx];
                const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
                if (assetUuid) {
                    const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
                    if(asset) this.meshSystem.updateSoftSelectionBuffer(meshIntId, new Float32Array(asset.geometry.vertices.length/3).fill(0));
                }
            }
            return;
        }

        const idx = Array.from(this.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return;

        const vertices = asset.geometry.vertices;
        const vertexCount = vertices.length / 3;
        
        // Get primary selection
        const selection = this.getSelectionAsVertices();
        
        let weights: Float32Array;

        if (this.softSelectionMode === 'FIXED') {
            // Euclidean Distance
            weights = new Float32Array(vertexCount);
            const radiusSq = this.softSelectionRadius * this.softSelectionRadius;
            
            // Collect selected positions
            const selPositions: number[] = [];
            selection.forEach(vIdx => {
                selPositions.push(vertices[vIdx*3], vertices[vIdx*3+1], vertices[vIdx*3+2]);
            });

            for(let i=0; i<vertexCount; i++) {
                if (selection.has(i)) {
                    weights[i] = 1.0;
                    continue;
                }
                const px = vertices[i*3], py = vertices[i*3+1], pz = vertices[i*3+2];
                let minDistSq = Infinity;
                
                for(let k=0; k<selPositions.length; k+=3) {
                    const dx = px - selPositions[k];
                    const dy = py - selPositions[k+1];
                    const dz = pz - selPositions[k+2];
                    const d2 = dx*dx + dy*dy + dz*dz;
                    if(d2 < minDistSq) minDistSq = d2;
                }

                if (minDistSq < radiusSq) {
                    const t = 1.0 - Math.sqrt(minDistSq) / this.softSelectionRadius;
                    weights[i] = t * t * (3 - 2 * t); // Smoothstep falloff
                } else {
                    weights[i] = 0.0;
                }
            }
        } else {
            // Dynamic / Surface (Topological)
            // Use MeshTopologyUtils for geodesic-like approximation (BFS)
            weights = MeshTopologyUtils.computeSurfaceWeights(
                asset.geometry.indices, 
                vertices, 
                selection, 
                this.softSelectionRadius, 
                vertexCount
            );
        }

        this.softSelectionWeights.set(meshIntId, weights);
        this.meshSystem.updateSoftSelectionBuffer(meshIntId, weights);
    }

    selectEntityAt(x: number, y: number, w: number, h: number): string | null {
        if (!this.currentViewProj) return null;
        
        const ray = RayUtils.create();
        // Adjust mouse coords to be centered in rect
        const invVP = new Float32Array(16);
        Mat4Utils.invert(this.currentViewProj, invVP);
        RayUtils.fromScreen(x, y, w, h, invVP, ray);

        let bestDist = Infinity;
        let bestId: string | null = null;

        // Naive iteration over all entities (optimize with BVH later)
        for (let i = 0; i < this.ecs.count; i++) {
            if (!this.ecs.store.isActive[i]) continue;
            
            const id = this.ecs.store.ids[i];
            const pos = { x: this.ecs.store.posX[i], y: this.ecs.store.posY[i], z: this.ecs.store.posZ[i] };
            
            // Simple sphere check for selection
            // Use AABB for better accuracy
            const dist = RayUtils.distRaySegment(ray, pos, pos); // Distance to center
            
            // Approx radius 1.0 for now, should use mesh bounds
            if (dist < 1.0) {
                const camDist = Vec3Utils.distance(this.currentCameraPos, pos);
                if (camDist < bestDist) {
                    bestDist = camDist;
                    bestId = id;
                }
            }
        }
        return bestId;
    }

    pickMeshComponent(entityId: string, x: number, y: number, w: number, h: number): MeshPickingResult | null {
        if (!this.currentViewProj) return null;
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return null;

        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        if (!assetUuid) return null;
        const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
        if (!asset) return null;

        const worldMat = this.sceneGraph.getWorldMatrix(entityId);
        if (!worldMat) return null;

        const invModel = Mat4Utils.create();
        Mat4Utils.invert(worldMat, invModel);

        const ray = RayUtils.create();
        const invVP = new Float32Array(16);
        Mat4Utils.invert(this.currentViewProj, invVP);
        RayUtils.fromScreen(x, y, w, h, invVP, ray);

        // Transform ray to local space
        const localOrigin = Vec3Utils.transformMat4(ray.origin, invModel, {x:0,y:0,z:0});
        // Transform direction (ignore translation)
        const localDir = Vec3Utils.transformMat4Normal(ray.direction, invModel, {x:0,y:0,z:0});
        Vec3Utils.normalize(localDir, localDir);
        
        const localRay = { origin: localOrigin, direction: localDir };

        return MeshTopologyUtils.raycastMesh(asset.topology || { faces: [], triangleToFaceIndex: new Int32Array(0), vertexToFaces: new Map() }, asset.geometry.vertices, localRay);
    }

    highlightVertexAt(x: number, y: number, w: number, h: number) {
        if (this.meshComponentMode !== 'VERTEX' || this.selectedIndices.size === 0) {
            this.hoveredVertex = null;
            return;
        }
        
        const pick = this.pickMeshComponent(this.ecs.store.ids[Array.from(this.selectedIndices)[0]], x, y, w, h);
        if (pick && pick.vertexId !== -1) {
            this.hoveredVertex = { 
                entityId: this.ecs.store.ids[Array.from(this.selectedIndices)[0]], 
                index: pick.vertexId 
            };
        } else {
            this.hoveredVertex = null;
        }
    }

    selectEntitiesInRect(x: number, y: number, w: number, h: number): string[] {
        // Implementation similar to selectComponentsInRect but for Object centroids
        const ids: string[] = [];
        if (!this.currentViewProj) return ids;
        
        const vp = this.currentViewProj;
        const m = new Float32Array(16);
        
        for (let i = 0; i < this.ecs.count; i++) {
            if (!this.ecs.store.isActive[i]) continue;
            
            // Project World Pos to Screen
            const worldPos = { x: this.ecs.store.posX[i], y: this.ecs.store.posY[i], z: this.ecs.store.posZ[i] };
            const clipPos = Vec3Utils.transformMat4(worldPos, vp, {x:0,y:0,z:0});
            // Manual w-division
            // ... (Full implementation omitted for brevity, similar to existing Rect Select)
            // Assuming simplified check:
            // Just select if center is in rect.
            
            // Re-using the matrix logic from selectComponentsInRect for now would be duplication.
            // Placeholder:
            // ...
        }
        return ids;
    }

    startVertexDrag(entityId: string) {
        const idx = this.ecs.idToIndex.get(entityId);
        if (idx === undefined) return;
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset) return;

        // Cache original positions of ALL vertices (or at least affected ones)
        // For simplicity, cache all.
        this.activeDeformationEntity = entityId;
        this.vertexSnapshot = {
            indices: Array.from({length: asset.geometry.vertices.length/3}, (_, i) => i),
            originalPositions: new Float32Array(asset.geometry.vertices)
        };
    }

    updateVertexDrag(entityId: string, delta: Vector3) {
        if (!this.vertexSnapshot || this.activeDeformationEntity !== entityId) return;
        
        const idx = this.ecs.idToIndex.get(entityId);
        const meshIntId = this.ecs.store.meshType[idx!];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        
        const softWeights = this.softSelectionWeights.get(meshIntId);
        const vertices = asset.geometry.vertices;
        const original = this.vertexSnapshot.originalPositions;
        
        // Affected vertices = Selection + Soft Selection
        const selection = this.getSelectionAsVertices();
        const loops = this.softSelectionEnabled && softWeights ? softWeights.length : selection.size;
        const arrSel = Array.from(selection);

        if (this.softSelectionEnabled && softWeights) {
            for(let i=0; i<softWeights.length; i++) {
                const w = softWeights[i];
                if (w > 0) {
                    vertices[i*3] = original[i*3] + delta.x * w;
                    vertices[i*3+1] = original[i*3+1] + delta.y * w;
                    vertices[i*3+2] = original[i*3+2] + delta.z * w;
                }
            }
        } else {
            arrSel.forEach(i => {
                vertices[i*3] = original[i*3] + delta.x;
                vertices[i*3+1] = original[i*3+1] + delta.y;
                vertices[i*3+2] = original[i*3+2] + delta.z;
            });
        }
        
        this.registerAssetWithGPU(asset);
    }

    endVertexDrag() {
        this.vertexSnapshot = null;
        this.activeDeformationEntity = null;
    }

    clearDeformation() {
        this.endVertexDrag();
    }

    selectLoop(type: 'VERTEX'|'EDGE'|'FACE') {
        if (this.selectedIndices.size === 0) return;
        const idx = Array.from(this.selectedIndices)[0];
        const meshIntId = this.ecs.store.meshType[idx];
        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
        if (!asset || !asset.topology) return;

        if (type === 'EDGE' && this.subSelection.edgeIds.size === 1) {
            const edgeKey = Array.from(this.subSelection.edgeIds)[0];
            const [v1, v2] = edgeKey.split('-').map(Number);
            const loop = MeshTopologyUtils.getEdgeLoop(asset.topology, v1, v2);
            loop.forEach(e => this.subSelection.edgeIds.add(e.sort((a,b)=>a-b).join('-')));
        }
        // ... Implement FACE/VERTEX loops similarly using MeshTopologyUtils
        this.notifyUI();
    }

    setRenderMode(mode: number) {
        this.renderMode = mode;
        this.notifyUI();
    }

    toggleGrid() {
        this.renderer.showGrid = !this.renderer.showGrid;
        this.notifyUI();
    }

    syncTransforms() {
        this.sceneGraph.update();
    }

    // --- MESH OPS (STUBS FOR PIE MENU) ---
    extrudeFaces() { consoleService.info('Extrude Faces (Mock)', 'Modeling'); }
    bevelEdges() { consoleService.info('Bevel Edges (Mock)', 'Modeling'); }
    weldVertices() { consoleService.info('Weld Vertices (Mock)', 'Modeling'); }
    connectComponents() { consoleService.info('Connect Components (Mock)', 'Modeling'); }
    deleteSelectedFaces() { consoleService.info('Delete Faces (Mock)', 'Modeling'); }
}

export const engineInstance = new Engine();
(window as any).engineInstance = engineInstance;
