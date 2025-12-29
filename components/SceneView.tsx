
import React, { useRef, useEffect, useState, useLayoutEffect, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Entity, ToolType, MeshComponentMode } from '../types';
import { SceneGraph } from '../services/SceneGraph';
import { engineInstance } from '../services/engine';
import { gizmoSystem } from '../services/GizmoSystem';
import { Mat4Utils, Vec3Utils, RayUtils } from '../services/math';
import { VIEW_MODES } from '../services/constants';
import { Icon } from './Icon';
import { PieMenu } from './PieMenu';
import { EditorContext } from '../contexts/EditorContext';
import { MeshTopologyUtils } from '../services/MeshTopologyUtils';
import { assetManager } from '../services/AssetManager';
import { StaticMeshAsset } from '../types';

interface SceneViewProps {
  entities: Entity[];
  sceneGraph: SceneGraph;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  tool: ToolType;
}

export const SceneView: React.FC<SceneViewProps> = ({ entities, sceneGraph, onSelect, selectedIds, tool }) => {
    const { 
        meshComponentMode, setMeshComponentMode, 
        softSelectionEnabled, setSoftSelectionEnabled,
        softSelectionRadius, setSoftSelectionRadius,
        softSelectionMode, 
        softSelectionFalloff,
        softSelectionHeatmapVisible,
        setTool
    } = useContext(EditorContext)!;
    
    // [FIX] Sync EditorContext state to Engine Instance
    useEffect(() => {
        engineInstance.meshComponentMode = meshComponentMode;
        engineInstance.softSelectionEnabled = softSelectionEnabled;
        engineInstance.softSelectionRadius = softSelectionRadius;
        engineInstance.softSelectionMode = softSelectionMode;
        engineInstance.softSelectionFalloff = softSelectionFalloff;
        engineInstance.softSelectionHeatmapVisible = softSelectionHeatmapVisible;
        engineInstance.recalculateSoftSelection(); // Recalculate weights on mode/radius change
    }, [meshComponentMode, softSelectionEnabled, softSelectionRadius, softSelectionMode, softSelectionFalloff, softSelectionHeatmapVisible]);

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewMenuRef = useRef<HTMLDivElement>(null);

    const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
    const [renderMode, setRenderMode] = useState(0);
    const [pieMenuState, setPieMenuState] = useState<{ x: number, y: number, entityId?: string } | null>(null);
    const [isAdjustingBrush, setIsAdjustingBrush] = useState(false);
    const brushStartPos = useRef({ x: 0, y: 0, startRadius: 0 });
    
    // Camera State (Mirroring Engine for UI, but engine holds truth)
    const [camera, setCamera] = useState({ theta: 0.5, phi: 1.2, radius: 10, target: { x: 0, y: 0, z: 0 } });
    
    const [dragState, setDragState] = useState<{
        isDragging: boolean;
        startX: number;
        startY: number;
        mode: 'ORBIT' | 'PAN' | 'ZOOM';
        startCamera: typeof camera;
    } | null>(null);

    const [selectionBox, setSelectionBox] = useState<{
        startX: number;
        startY: number;
        currentX: number;
        currentY: number;
        isSelecting: boolean;
    } | null>(null);

    // Initialize Engine with Canvas
    useLayoutEffect(() => {
        if (canvasRef.current && !engineInstance.renderer.gl) {
            engineInstance.initGL(canvasRef.current);
        }
        
        const handleResize = () => {
            if (containerRef.current) {
                const { width, height } = containerRef.current.getBoundingClientRect();
                engineInstance.resize(width, height);
            }
        };
        const obs = new ResizeObserver(handleResize);
        if (containerRef.current) obs.observe(containerRef.current);
        
        return () => obs.disconnect();
    }, []);

    // Sync Camera from Engine to React State
    useEffect(() => {
        const update = () => {
            const eyeX = camera.target.x + camera.radius * Math.sin(camera.phi) * Math.cos(camera.theta);
            const eyeY = camera.target.y + camera.radius * Math.cos(camera.phi);
            const eyeZ = camera.target.z + camera.radius * Math.sin(camera.phi) * Math.sin(camera.theta);
            
            // Prevent NaN propagation
            if (isNaN(eyeX) || isNaN(eyeY) || isNaN(eyeZ)) {
                console.error("Invalid Camera State Detected - Resetting");
                setCamera({ theta: 0.5, phi: 1.2, radius: 10, target: { x: 0, y: 0, z: 0 } });
                return;
            }

            const aspect = containerRef.current ? (containerRef.current.clientWidth / containerRef.current.clientHeight) : 1;
            const proj = Mat4Utils.create();
            Mat4Utils.perspective(45 * Math.PI / 180, aspect, 0.1, 1000.0, proj);
            
            const view = Mat4Utils.create();
            Mat4Utils.lookAt({x:eyeX, y:eyeY, z:eyeZ}, camera.target, {x:0,y:1,z:0}, view);
            
            const vp = Mat4Utils.create();
            Mat4Utils.multiply(proj, view, vp);
            
            engineInstance.updateCamera(vp, {x:eyeX, y:eyeY, z:eyeZ}, containerRef.current?.clientWidth || 1, containerRef.current?.clientHeight || 1);
            gizmoSystem.setTool(tool);
            engineInstance.tick(0);
        };
        update();
    }, [camera, tool]);

    // Animation Loop
    useEffect(() => {
        let lastTime = performance.now();
        let frameId: number;
        
        const loop = (time: number) => {
            const dt = (time - lastTime) / 1000;
            lastTime = time;
            
            const eyeX = camera.target.x + camera.radius * Math.sin(camera.phi) * Math.cos(camera.theta);
            const eyeY = camera.target.y + camera.radius * Math.cos(camera.phi);
            const eyeZ = camera.target.z + camera.radius * Math.sin(camera.phi) * Math.sin(camera.theta);
            
            if (isNaN(eyeX)) return; // Skip frame if bad math

            const width = containerRef.current?.clientWidth || 1;
            const height = containerRef.current?.clientHeight || 1;
            const aspect = width / height;
            
            const proj = Mat4Utils.create();
            Mat4Utils.perspective(45 * Math.PI / 180, aspect, 0.1, 1000.0, proj);
            
            const view = Mat4Utils.create();
            Mat4Utils.lookAt({x:eyeX, y:eyeY, z:eyeZ}, camera.target, {x:0,y:1,z:0}, view);
            
            const vp = Mat4Utils.create();
            Mat4Utils.multiply(proj, view, vp);
            
            engineInstance.updateCamera(vp, {x:eyeX, y:eyeY, z:eyeZ}, width, height);
            
            // Visualizer for Soft Selection Radius
            if (engineInstance.meshComponentMode !== 'OBJECT' && engineInstance.subSelection.vertexIds.size > 0 && softSelectionEnabled) {
                const entityId = engineInstance.ecs.store.ids[Array.from(engineInstance.selectedIndices)[0]];
                if (entityId) {
                    const worldPos = engineInstance.sceneGraph.getWorldPosition(entityId); 
                    const segments = 32;
                    const rad = softSelectionRadius;
                    const prev = { x: worldPos.x + rad, y: worldPos.y, z: worldPos.z };
                    for(let i=1; i<=segments; i++) {
                        const th = (i/segments) * Math.PI * 2;
                        const cur = { 
                            x: worldPos.x + Math.cos(th) * rad, 
                            y: worldPos.y, 
                            z: worldPos.z + Math.sin(th) * rad 
                        };
                        engineInstance.debugRenderer.drawLine(prev, cur, { r: 1, g: 1, b: 0 }); // Yellow Ring
                        prev.x = cur.x; prev.y = cur.y; prev.z = cur.z;
                    }
                }
            }

            engineInstance.tick(dt);
            frameId = requestAnimationFrame(loop);
        };
        frameId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frameId);
    }, [camera, softSelectionEnabled, softSelectionRadius]); 

    // Focus Camera Logic (Enhanced with Robustness)
    const handleFocus = useCallback(() => {
        // 1. Component Mode Focus
        if (meshComponentMode !== 'OBJECT' && selectedIds.length > 0) {
            const entityId = selectedIds[0];
            const idx = engineInstance.ecs.idToIndex.get(entityId);
            if (idx === undefined) return;

            const meshIntId = engineInstance.ecs.store.meshType[idx];
            const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
            if (!assetUuid) return;
            const asset = assetManager.getAsset(assetUuid) as StaticMeshAsset;
            if (!asset) return;

            const worldMat = engineInstance.sceneGraph.getWorldMatrix(entityId);
            if (!worldMat) return;

            const vertices = asset.geometry.vertices;
            let cx = 0, cy = 0, cz = 0;
            let count = 0;

            const addVertex = (vIdx: number) => {
                // Safety: Bounds Check
                if (vIdx < 0 || vIdx * 3 + 2 >= vertices.length) return;

                const x = vertices[vIdx*3];
                const y = vertices[vIdx*3+1];
                const z = vertices[vIdx*3+2];
                
                // Safety: NaN Check
                if (isNaN(x) || isNaN(y) || isNaN(z)) return;

                // Transform to world
                const wx = worldMat[0]*x + worldMat[4]*y + worldMat[8]*z + worldMat[12];
                const wy = worldMat[1]*x + worldMat[5]*y + worldMat[9]*z + worldMat[13];
                const wz = worldMat[2]*x + worldMat[6]*y + worldMat[10]*z + worldMat[14];
                
                // Safety: Result Check
                if (!isNaN(wx) && !isNaN(wy) && !isNaN(wz)) {
                    cx += wx; cy += wy; cz += wz;
                    count++;
                }
            };

            if (meshComponentMode === 'VERTEX') {
                engineInstance.subSelection.vertexIds.forEach(v => addVertex(v));
            } else if (meshComponentMode === 'EDGE') {
                engineInstance.subSelection.edgeIds.forEach(key => {
                    const parts = key.split('-').map(Number);
                    if (parts.length === 2) {
                        addVertex(parts[0]); addVertex(parts[1]);
                    }
                });
            } else if (meshComponentMode === 'FACE') {
                const topo = asset.topology;
                engineInstance.subSelection.faceIds.forEach(fIdx => {
                    if (topo && topo.faces[fIdx]) {
                        topo.faces[fIdx].forEach(v => addVertex(v));
                    } else {
                        // Fallback
                        const idxs = asset.geometry.indices;
                        if (idxs && fIdx * 3 + 2 < idxs.length) {
                            addVertex(idxs[fIdx*3]);
                            addVertex(idxs[fIdx*3+1]);
                            addVertex(idxs[fIdx*3+2]);
                        }
                    }
                });
            }

            if (count > 0) {
                const tx = cx/count;
                const ty = cy/count;
                const tz = cz/count;
                
                setCamera(prev => ({ 
                    ...prev, 
                    target: { x: tx, y: ty, z: tz },
                    radius: Math.max(1.5, prev.radius * 0.4) // Closer zoom for components
                }));
                return;
            }
        }

        // 2. Object Mode Focus
        if (selectedIds.length > 0) {
            let cx = 0, cy = 0, cz = 0;
            let count = 0;
            
            selectedIds.forEach(id => {
                const pos = sceneGraph.getWorldPosition(id);
                if (!isNaN(pos.x)) {
                    cx += pos.x; cy += pos.y; cz += pos.z;
                    count++;
                }
            });
            
            if (count > 0) {
                const target = { x: cx / count, y: cy / count, z: cz / count };
                setCamera(prev => ({ 
                    ...prev, 
                    target, 
                    radius: Math.max(3.0, prev.radius * 0.5) 
                }));
            }
        } else {
            setCamera(prev => ({ ...prev, target: {x:0, y:0, z:0}, radius: 10 }));
        }
    }, [selectedIds, sceneGraph, meshComponentMode]);

    // Keyboard 'F' for Focus
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const active = document.activeElement;
            const isInput = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA';
            if (isInput) return;

            if (e.key.toLowerCase() === 'f') {
                handleFocus();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleFocus]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (pieMenuState && e.button !== 2) setPieMenuState(null);
        if (pieMenuState) return;

        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left; 
        const my = e.clientY - rect.top;

        // 0. Soft Selection Radius Adjustment
        if (e.altKey && e.button === 0 && meshComponentMode !== 'OBJECT') {
            // Handled by global listeners
        }

        // 1. GIZMO CHECK
        if (e.button === 0 && !isAdjustingBrush && !e.altKey) {
            gizmoSystem.update(0, mx, my, rect.width, rect.height, true, false);
            if (gizmoSystem.activeAxis) return; 
        }

        // 2. Right Click (Pie Menu)
        if (e.button === 2 && !e.altKey) {
            const hitId = engineInstance.selectEntityAt(mx, my, rect.width, rect.height);
            if (hitId) {
                if (!selectedIds.includes(hitId)) {
                    onSelect([hitId]);
                }
                setPieMenuState({ x: e.clientX, y: e.clientY, entityId: hitId });
            } else if (selectedIds.length > 0) {
                // Open pie menu even if clicking void but having selection (for mode switch)
                setPieMenuState({ x: e.clientX, y: e.clientY });
            }
            return;
        }

        // 3. Selection
        // Alt + Click = Loop Selection
        if (e.button === 0 && !isAdjustingBrush) {
            engineInstance.isInputDown = true;
            
            let componentHit = false;
            
            if (meshComponentMode !== 'OBJECT' && selectedIds.length > 0) {
                const result = engineInstance.pickMeshComponent(selectedIds[0], mx, my, rect.width, rect.height);
                
                if (result) {
                    engineInstance.clearDeformation(); 
                    componentHit = true;
                    
                    if (!e.shiftKey) {
                        engineInstance.subSelection.vertexIds.clear();
                        engineInstance.subSelection.edgeIds.clear();
                        engineInstance.subSelection.faceIds.clear();
                    }

                    // --- LOOP SELECTION LOGIC ---
                    if (e.altKey) {
                        const idx = engineInstance.ecs.idToIndex.get(selectedIds[0]);
                        const meshIntId = engineInstance.ecs.store.meshType[idx!];
                        const assetUuid = assetManager.meshIntToUuid.get(meshIntId);
                        const asset = assetManager.getAsset(assetUuid!) as StaticMeshAsset;
                        
                        if (asset && asset.topology) {
                            if (meshComponentMode === 'EDGE') {
                                // Edge Loop (Longitudinal)
                                const loop = MeshTopologyUtils.getEdgeLoop(asset.topology, result.edgeId[0], result.edgeId[1]);
                                loop.forEach(edge => {
                                    const key = edge.sort((a,b)=>a-b).join('-');
                                    engineInstance.subSelection.edgeIds.add(key);
                                });
                            } else if (meshComponentMode === 'FACE') {
                                // Face Loop (Strip)
                                const loop = MeshTopologyUtils.getFaceLoop(asset.topology, result.edgeId[0], result.edgeId[1]);
                                loop.forEach(f => engineInstance.subSelection.faceIds.add(f));
                            } else if (meshComponentMode === 'VERTEX') {
                                // Vertex Loop Logic
                                const previouslySelected = Array.from(engineInstance.subSelection.vertexIds);
                                const clickedV = result.vertexId;
                                let loopFound = false;

                                // 1. Directional Selection: If exactly 1 vertex was selected, and we clicked a neighbor
                                if (previouslySelected.length === 1 && clickedV !== -1 && clickedV !== previouslySelected[0]) {
                                    const v1 = previouslySelected[0];
                                    const v2 = clickedV;
                                    
                                    // Verify connectivity via edge map
                                    const graph = asset.topology.graph;
                                    const key = [v1, v2].sort((a,b)=>a-b).join('-');
                                    
                                    if (graph && graph.edgeKeyToHalfEdge.has(key)) {
                                        const loop = MeshTopologyUtils.getVertexLoop(asset.topology, v1, v2);
                                        if (loop.length > 0) {
                                            loop.forEach(v => engineInstance.subSelection.vertexIds.add(v));
                                            loopFound = true;
                                        }
                                    }
                                }

                                // 2. Fallback: Use the edge closest to cursor (raycast hit)
                                if (!loopFound) {
                                    // result.edgeId is always valid from raycastMesh (closest edge on face)
                                    const loop = MeshTopologyUtils.getVertexLoop(asset.topology, result.edgeId[0], result.edgeId[1]);
                                    loop.forEach(v => engineInstance.subSelection.vertexIds.add(v));
                                }
                            }
                        }
                    } else {
                        // Standard Single Click
                        if (meshComponentMode === 'VERTEX') {
                            const id = result.vertexId;
                            if (engineInstance.subSelection.vertexIds.has(id)) engineInstance.subSelection.vertexIds.delete(id);
                            else engineInstance.subSelection.vertexIds.add(id);
                        } else if (meshComponentMode === 'EDGE') {
                            const id = result.edgeId.sort((a,b)=>a-b).join('-');
                            if (engineInstance.subSelection.edgeIds.has(id)) engineInstance.subSelection.edgeIds.delete(id);
                            else engineInstance.subSelection.edgeIds.add(id);
                        } else if (meshComponentMode === 'FACE') {
                            const id = result.faceId;
                            if (engineInstance.subSelection.faceIds.has(id)) engineInstance.subSelection.faceIds.delete(id);
                            else engineInstance.subSelection.faceIds.add(id);
                        }
                    }
                    
                    engineInstance.recalculateSoftSelection(); 
                    engineInstance.notifyUI();
                    return;
                }
            }

            // Object Selection
            if (!componentHit) {
                const hitId = engineInstance.selectEntityAt(mx, my, rect.width, rect.height);
                if (hitId) {
                    if (meshComponentMode !== 'OBJECT') {
                        if (!selectedIds.includes(hitId)) setMeshComponentMode('OBJECT');
                        if (!e.shiftKey) {
                            engineInstance.clearDeformation(); 
                            engineInstance.subSelection.vertexIds.clear();
                            engineInstance.subSelection.edgeIds.clear();
                            engineInstance.subSelection.faceIds.clear();
                            engineInstance.notifyUI();
                        }
                    }
                    if (e.shiftKey) {
                        const newSel = selectedIds.includes(hitId) ? selectedIds.filter(id => id !== hitId) : [...selectedIds, hitId];
                        onSelect(newSel);
                    } else {
                        onSelect([hitId]);
                    }
                } else if (!e.altKey) {
                    // Box Selection Start
                    if (!e.shiftKey) {
                        if (meshComponentMode !== 'OBJECT') {
                            engineInstance.clearDeformation(); 
                            engineInstance.subSelection.vertexIds.clear();
                            engineInstance.subSelection.edgeIds.clear();
                            engineInstance.subSelection.faceIds.clear();
                            engineInstance.notifyUI();
                        }
                    }
                    setSelectionBox({ startX: mx, startY: my, currentX: mx, currentY: my, isSelecting: true });
                }
            }
        }

        // 4. Navigation
        if (e.altKey && e.button !== 0 || (e.altKey && e.button === 0 && !isAdjustingBrush)) {
            e.preventDefault();
            let mode: 'ORBIT' | 'PAN' | 'ZOOM' = 'ORBIT';
            if (e.button === 1 || (e.altKey && e.button === 1)) mode = 'PAN';
            if (e.button === 2 || (e.altKey && e.button === 2)) mode = 'ZOOM';
            if (e.altKey && e.button === 0) mode = 'ORBIT'; 
            
            setDragState({ isDragging: true, startX: e.clientX, startY: e.clientY, mode, startCamera: { ...camera } });
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        if (selectionBox?.isSelecting) {
            const x = Math.min(selectionBox.startX, selectionBox.currentX);
            const y = Math.min(selectionBox.startY, selectionBox.currentY);
            const w = Math.abs(selectionBox.currentX - selectionBox.startX);
            const h = Math.abs(selectionBox.currentY - selectionBox.startY);
            
            if (w > 3 || h > 3) {
                const hitIds = engineInstance.selectEntitiesInRect(x, y, w, h);
                if (e.shiftKey) {
                    const nextSelection = new Set(selectedIds);
                    hitIds.forEach(id => {
                        if (nextSelection.has(id)) nextSelection.delete(id);
                        else nextSelection.add(id);
                    });
                    onSelect(Array.from(nextSelection));
                } else {
                    onSelect(hitIds);
                }
            } else {
                if (!e.shiftKey && e.button === 0) onSelect([]);
            }
            setSelectionBox(null);
        }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (isAdjustingBrush) {
            const dx = e.clientX - brushStartPos.current.x;
            const sensitivity = 0.05;
            const newRad = Math.max(0.1, brushStartPos.current.startRadius + dx * sensitivity);
            setSoftSelectionRadius(newRad);
            return;
        }

        gizmoSystem.update(0, mx, my, rect.width, rect.height, false, false);

        if (meshComponentMode !== 'OBJECT') {
            if (meshComponentMode === 'VERTEX') engineInstance.highlightVertexAt(mx, my, rect.width, rect.height);
        }

        if (dragState && dragState.isDragging) {
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;

            if (dragState.mode === 'ORBIT') {
                setCamera(prev => ({
                    ...prev,
                    theta: dragState.startCamera.theta + dx * 0.01,
                    phi: Math.max(0.1, Math.min(Math.PI - 0.1, dragState.startCamera.phi - dy * 0.01))
                }));
            } else if (dragState.mode === 'ZOOM') {
                setCamera(prev => ({ ...prev, radius: Math.max(1, dragState.startCamera.radius - (dx - dy) * 0.05) }));
            } else if (dragState.mode === 'PAN') {
                const panSpeed = dragState.startCamera.radius * 0.001;
                const eyeX = dragState.startCamera.radius * Math.sin(dragState.startCamera.phi) * Math.cos(dragState.startCamera.theta);
                const eyeY = dragState.startCamera.radius * Math.cos(dragState.startCamera.phi);
                const eyeZ = dragState.startCamera.radius * Math.sin(dragState.startCamera.phi) * Math.sin(dragState.startCamera.theta);
                const forward = Vec3Utils.normalize(Vec3Utils.scale({x:eyeX,y:eyeY,z:eyeZ}, -1, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                const right = Vec3Utils.normalize(Vec3Utils.cross(forward, {x:0,y:1,z:0}, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                const camUp = Vec3Utils.normalize(Vec3Utils.cross(right, forward, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                const moveX = Vec3Utils.scale(right, -dx * panSpeed, {x:0,y:0,z:0});
                const moveY = Vec3Utils.scale(camUp, dy * panSpeed, {x:0,y:0,z:0});
                setCamera(prev => ({ ...prev, target: Vec3Utils.add(dragState.startCamera.target, Vec3Utils.add(moveX, moveY, {x:0,y:0,z:0}), {x:0,y:0,z:0}) }));
            }
        }

        if (selectionBox?.isSelecting) {
            setSelectionBox(prev => prev ? ({...prev, currentX: mx, currentY: my}) : null);
        }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
        engineInstance.isInputDown = false;
        if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            gizmoSystem.update(0, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, false, true);
        }
        setDragState(null);
        setIsAdjustingBrush(false);
    };

    // Global Key Listener for B interaction
    useEffect(() => {
        let bDown = false;
        const onDown = (e: KeyboardEvent) => { if(e.key.toLowerCase() === 'b') bDown = true; };
        const onUp = (e: KeyboardEvent) => { if(e.key.toLowerCase() === 'b') bDown = false; };
        
        const onWindowMouseDown = (e: MouseEvent) => {
            if (bDown && e.button === 0) {
                e.preventDefault(); e.stopPropagation();
                if (!softSelectionEnabled) setSoftSelectionEnabled(true);
                setIsAdjustingBrush(true);
                brushStartPos.current = { x: e.clientX, y: e.clientY, startRadius: softSelectionRadius };
            }
        };

        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        window.addEventListener('mousedown', onWindowMouseDown); 
        
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
            window.removeEventListener('mousedown', onWindowMouseDown);
        };
    }, [softSelectionRadius, setSoftSelectionEnabled, softSelectionEnabled]);

    useEffect(() => {
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [dragState, selectionBox, meshComponentMode, isAdjustingBrush]);

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const assetId = e.dataTransfer.getData('application/ti3d-asset');
        if (assetId && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            const invVP = new Float32Array(16);
            if (Mat4Utils.invert(engineInstance.currentViewProj!, invVP)) {
                const ray = RayUtils.create();
                RayUtils.fromScreen(x, y, rect.width, rect.height, invVP, ray);
                let pos = { x: 0, y: 0, z: 0 };
                if (Math.abs(ray.direction.y) > 0.001) {
                    const t = -ray.origin.y / ray.direction.y;
                    if (t > 0) pos = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, t, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                    else pos = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, 10, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                } else {
                    pos = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, 10, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                }
                const id = engineInstance.createEntityFromAsset(assetId, pos);
                if (id) onSelect([id]);
            }
        }
    };

    const handleModeSelect = (modeId: number) => { 
        engineInstance.setRenderMode(modeId); 
        setRenderMode(modeId); 
        setIsViewMenuOpen(false); 
    };

    const handlePieAction = (action: string) => {
        // --- SELECTION TOOLS ---
        if (action === 'tool_select') setTool('SELECT');
        if (action === 'tool_move') setTool('MOVE');
        if (action === 'tool_rotate') setTool('ROTATE');
        if (action === 'tool_scale') setTool('SCALE');

        // --- VIEW ---
        if (action === 'toggle_grid') engineInstance.toggleGrid();
        if (action === 'toggle_wire') handleModeSelect(3); // Wireframe
        if (action === 'reset_cam') handleFocus();

        // --- OBJECT ACTIONS ---
        if (action === 'delete') { selectedIds.forEach(id => engineInstance.deleteEntity(id, sceneGraph)); onSelect([]); }
        if (action === 'duplicate') { selectedIds.forEach(id => engineInstance.duplicateEntity(id)); }
        if (action === 'focus') { handleFocus(); }

        // --- MESH EDIT ACTIONS ---
        if (action === 'extrude') engineInstance.extrudeFaces();
        if (action === 'bevel') engineInstance.bevelEdges();
        if (action === 'weld') engineInstance.weldVertices();
        if (action === 'connect') engineInstance.connectComponents();
        if (action === 'delete_face') engineInstance.deleteSelectedFaces();
        
        // --- LOOP SELECTION ACTIONS ---
        if (action === 'loop_vert') engineInstance.selectLoop('VERTEX');
        if (action === 'loop_edge') engineInstance.selectLoop('EDGE');
        if (action === 'loop_face') engineInstance.selectLoop('FACE');
        
        setPieMenuState(null);
    };

    return (
        <div ref={containerRef} 
             className={`w-full h-full bg-[#151515] relative overflow-hidden select-none group/scene ${isAdjustingBrush ? 'cursor-ew-resize' : (dragState ? (dragState.mode === 'PAN' ? 'cursor-move' : 'cursor-grabbing') : 'cursor-default')}`} 
             onMouseDown={handleMouseDown} 
             onMouseUp={handleMouseUp} 
             onDragOver={handleDragOver}
             onDrop={handleDrop}
             onWheel={(e) => setCamera(p => ({ ...p, radius: Math.max(2, p.radius + e.deltaY * 0.01) }))} 
             onContextMenu={(e) => e.preventDefault()}
        >
            <canvas ref={canvasRef} className="block w-full h-full outline-none" />
            
            {selectionBox && selectionBox.isSelecting && (
                <div className="absolute border border-blue-500 bg-blue-500/20 pointer-events-none z-30" 
                     style={{ 
                         left: Math.min(selectionBox.startX, selectionBox.currentX), 
                         top: Math.min(selectionBox.startY, selectionBox.currentY), 
                         width: Math.abs(selectionBox.currentX - selectionBox.startX), 
                         height: Math.abs(selectionBox.currentY - selectionBox.startY) 
                     }} 
                />
            )}
            
            <div className="absolute top-3 left-3 flex gap-2 z-20">
                <div className="bg-black/40 backdrop-blur border border-white/5 rounded-md flex p-1 text-text-secondary">
                     <button className="p-1 hover:text-white rounded hover:bg-white/10" onClick={() => engineInstance.toggleGrid()} title="Toggle Grid"><Icon name="Grid" size={14} /></button>
                </div>
                
                <div className="relative" ref={viewMenuRef}>
                    <div className="bg-black/40 backdrop-blur border border-white/5 rounded-md flex items-center px-2 py-1 text-[10px] text-text-secondary min-w-[100px] justify-between cursor-pointer hover:bg-white/5 group" onClick={() => setIsViewMenuOpen(!isViewMenuOpen)}>
                        <div className="flex items-center gap-2">
                            <Icon name={(VIEW_MODES.find(m => m.id === renderMode) || VIEW_MODES[0]).icon as any} size={12} className="text-accent" />
                            <span className="font-semibold text-white/90">{(VIEW_MODES.find(m => m.id === renderMode) || VIEW_MODES[0]).label}</span>
                        </div>
                        <Icon name="ChevronDown" size={10} className={`text-text-secondary transition-transform ${isViewMenuOpen ? 'rotate-180' : ''}`} />
                    </div>
                    {isViewMenuOpen && (
                        <div className="absolute top-full left-0 mt-1 w-32 bg-[#252525] border border-white/10 rounded-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 z-50">
                            {VIEW_MODES.map((mode) => (
                                <button key={mode.id} onClick={() => handleModeSelect(mode.id)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-accent hover:text-white transition-colors text-left ${mode.id === renderMode ? 'bg-white/5 text-white font-bold' : 'text-text-secondary'}`}>
                                    <Icon name={mode.icon as any} size={12} />
                                    <span>{mode.label}</span>
                                    {mode.id === renderMode && <Icon name="Check" size={10} className="ml-auto" />}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            
            <div className="absolute bottom-2 right-2 text-[10px] text-text-secondary bg-black/40 px-2 py-0.5 rounded backdrop-blur border border-white/5 z-20 flex flex-col items-end">
                <span>Cam: {camera.target.x.toFixed(1)}, {camera.target.y.toFixed(1)}, {camera.target.z.toFixed(1)}</span>
                {softSelectionEnabled && meshComponentMode !== 'OBJECT' && (
                    <span className="text-accent">Soft Sel ({softSelectionMode === 'FIXED' ? 'Fixed' : 'Dynamic'}): {softSelectionRadius.toFixed(1)}m</span>
                )}
            </div>

            {isAdjustingBrush && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white font-bold text-2xl drop-shadow-md z-50 pointer-events-none">
                    Radius: {softSelectionRadius.toFixed(2)}
                </div>
            )}

            {pieMenuState && createPortal(
                <PieMenu 
                    x={pieMenuState.x} 
                    y={pieMenuState.y}
                    entityId={pieMenuState.entityId}
                    currentMode={meshComponentMode}
                    onSelectMode={(m) => { setMeshComponentMode(m); setPieMenuState(null); }}
                    onAction={handlePieAction}
                    onClose={() => setPieMenuState(null)}
                />, 
                document.body
            )}
        </div>
    );
};
