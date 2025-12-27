
import React, { useRef, useState, useEffect, useLayoutEffect, useMemo, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Entity, ToolType, PerformanceMetrics, MeshComponentMode } from '../types';
import { SceneGraph } from '../services/SceneGraph';
import { Mat4Utils, Vec3Utils, RayUtils } from '../services/math';
import { engineInstance } from '../services/engine';
import { assetManager } from '../services/AssetManager';
import { Icon } from './Icon';
import { VIEW_MODES } from '../services/constants';
import { EditorContext } from '../contexts/EditorContext';
import { gizmoSystem } from '../services/GizmoSystem'; 
import { PieMenu } from './PieMenu';

interface SceneViewProps {
  entities: Entity[];
  sceneGraph: SceneGraph;
  onSelect: (ids: string[]) => void;
  selectedIds: string[];
  tool: ToolType;
}

const StatsOverlay: React.FC = () => {
    const [metrics, setMetrics] = useState<PerformanceMetrics>(engineInstance.metrics);
    useEffect(() => {
        const interval = setInterval(() => {
            setMetrics({...engineInstance.metrics});
        }, 500);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="absolute top-10 right-2 bg-black/60 backdrop-blur border border-white/10 rounded-md p-2 text-[10px] font-mono text-text-secondary select-none pointer-events-none z-30 shadow-lg">
            <div className="flex justify-between gap-4"><span className="text-white">FPS</span> <span className={metrics.fps < 30 ? "text-red-500" : "text-green-500"}>{metrics.fps.toFixed(0)}</span></div>
            <div className="flex justify-between gap-4"><span>Frame</span> <span>{metrics.frameTime.toFixed(2)}ms</span></div>
            <div className="flex justify-between gap-4"><span>Calls</span> <span>{metrics.drawCalls}</span></div>
            <div className="flex justify-between gap-4"><span>Tris</span> <span>{metrics.triangleCount}</span></div>
            <div className="flex justify-between gap-4"><span>Ents</span> <span>{metrics.entityCount}</span></div>
        </div>
    );
};

export const SceneView: React.FC<SceneViewProps> = ({ entities, sceneGraph, onSelect, selectedIds, tool }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { meshComponentMode, setMeshComponentMode } = useContext(EditorContext)!;
  const [renderMode, setRenderMode] = useState(engineInstance.renderMode);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  
  // Pie Menu State - Now tracks entityId to ensure actions target the correct object
  const [pieMenuState, setPieMenuState] = useState<{x: number, y: number, entityId: string} | null>(null);

  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [camera, setCamera] = useState({
    target: { x: 0, y: 0, z: 0 },
    theta: Math.PI / 4, 
    phi: Math.PI / 3,   
    radius: 10
  });

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

  // --- Initialization ---
  useLayoutEffect(() => {
    if (canvasRef.current && containerRef.current) {
        engineInstance.initGL(canvasRef.current);
        const observer = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            setViewport({ width, height });
            engineInstance.resize(width, height);
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }
  }, []);

  // --- Main Loop ---
  useEffect(() => {
      let frameId: number;
      let lastTime = performance.now();
      const loop = (time: number) => {
          const dt = (time - lastTime) / 1000;
          lastTime = time;
          engineInstance.tick(dt); 
          frameId = requestAnimationFrame(loop);
      };
      frameId = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
      engineInstance.setSelected(selectedIds);
  }, [selectedIds]);

  useEffect(() => {
      engineInstance.meshComponentMode = meshComponentMode;
  }, [meshComponentMode]);

  // SYNC TOOL: Make GizmoSystem respect the current tool (Hide on SELECT)
  useEffect(() => {
      gizmoSystem.setTool(tool);
  }, [tool]);

  // --- Camera Logic ---
  const { vpMatrix, eye } = useMemo(() => {
    const { width, height } = viewport;
    const eyeX = camera.target.x + camera.radius * Math.sin(camera.phi) * Math.cos(camera.theta);
    const eyeY = camera.target.y + camera.radius * Math.cos(camera.phi);
    const eyeZ = camera.target.z + camera.radius * Math.sin(camera.phi) * Math.sin(camera.theta);
    const eyeVec = { x: eyeX, y: eyeY, z: eyeZ };
    const viewMatrix = Mat4Utils.create();
    Mat4Utils.lookAt(eyeVec, camera.target, { x: 0, y: 1, z: 0 }, viewMatrix);
    const projMatrix = Mat4Utils.create();
    Mat4Utils.perspective(Math.PI / 4, width/height, 0.1, 1000, projMatrix);
    const vp = Mat4Utils.create(); Mat4Utils.multiply(projMatrix, viewMatrix, vp);
    return { vpMatrix: vp, eye: eyeVec };
  }, [camera, viewport.width, viewport.height]);

  useEffect(() => {
    if (viewport.width > 1) engineInstance.updateCamera(vpMatrix, eye, viewport.width, viewport.height);
  }, [vpMatrix, eye, viewport.width, viewport.height]);

  // --- Focus Functionality ---
  const handleFocus = useCallback((targetId?: string) => {
      const idsToFocus = targetId ? [targetId] : selectedIds;
      if (idsToFocus.length === 0) return;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let hasBounds = false;

      idsToFocus.forEach(id => {
          const idx = engineInstance.ecs.idToIndex.get(id);
          if (idx === undefined) return;

          // Get World Matrix
          const store = engineInstance.ecs.store;
          const wm = store.worldMatrix.subarray(idx * 16, idx * 16 + 16);

          // Check for Mesh
          const meshIntId = store.meshType[idx];
          const assetId = assetManager.meshIntToUuid.get(meshIntId);
          const asset = assetId ? assetManager.getAsset(assetId) : null;

          if (asset && (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH')) {
              // Calculate Local Bounds (Simple scan)
              const verts = (asset as any).geometry.vertices;
              let lMinX=Infinity, lMinY=Infinity, lMinZ=Infinity;
              let lMaxX=-Infinity, lMaxY=-Infinity, lMaxZ=-Infinity;
              
              // Only sample vertices to calculate OBB roughly if too many, but full scan for accuracy
              const step = verts.length > 3000 ? 30 : 3; // Optimization for large meshes
              for(let i=0; i<verts.length; i+=step) {
                  lMinX = Math.min(lMinX, verts[i]); lMaxX = Math.max(lMaxX, verts[i]);
                  lMinY = Math.min(lMinY, verts[i+1]); lMaxY = Math.max(lMaxY, verts[i+1]);
                  lMinZ = Math.min(lMinZ, verts[i+2]); lMaxZ = Math.max(lMaxZ, verts[i+2]);
              }

              // Transform 8 corners of the AABB to find world AABB
              const corners = [
                  {x:lMinX, y:lMinY, z:lMinZ}, {x:lMaxX, y:lMinY, z:lMinZ},
                  {x:lMinX, y:lMaxY, z:lMinZ}, {x:lMaxX, y:lMaxY, z:lMinZ},
                  {x:lMinX, y:lMinY, z:lMaxZ}, {x:lMaxX, y:lMinY, z:lMaxZ},
                  {x:lMinX, y:lMaxY, z:lMaxZ}, {x:lMaxX, y:lMaxY, z:lMaxZ}
              ];

              corners.forEach(c => {
                  const wx = wm[0]*c.x + wm[4]*c.y + wm[8]*c.z + wm[12];
                  const wy = wm[1]*c.x + wm[5]*c.y + wm[9]*c.z + wm[13];
                  const wz = wm[2]*c.x + wm[6]*c.y + wm[10]*c.z + wm[14];
                  minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
                  minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
                  minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
              });
              hasBounds = true;
          } else {
              // Just use position if no mesh
              const x = wm[12], y = wm[13], z = wm[14];
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
              minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
              hasBounds = true;
          }
      });

      if (hasBounds) {
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const cz = (minZ + maxZ) / 2;
          const size = Math.sqrt(Math.pow(maxX - minX, 2) + Math.pow(maxY - minY, 2) + Math.pow(maxZ - minZ, 2));
          
          setCamera(prev => ({
              ...prev,
              target: { x: cx, y: cy, z: cz },
              radius: Math.max(2, size * 1.5) // Fit multiplier
          }));
      }
  }, [selectedIds]);

  // --- Focus Shortcut (F Key) ---
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          const active = document.activeElement;
          if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;

          if (e.key === 'f' || e.key === 'F') {
              handleFocus();
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleFocus]);

  // --- Input Handling ---

  const handleMouseDown = (e: React.MouseEvent) => {
    if (pieMenuState && e.button !== 2) setPieMenuState(null); // Close pie menu if clicking elsewhere (except right click)
    if (pieMenuState) return;

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left; 
    const my = e.clientY - rect.top;

    // 1. GIZMO CHECK (Priority)
    // If gizmo is active and clicked, it consumes the event.
    gizmoSystem.update(0, mx, my, rect.width, rect.height, true, false);
    if (gizmoSystem.activeAxis) return; 

    // 2. Right Click (Pie Menu or Context)
    if (e.button === 2 && !e.altKey) {
        // Try to pick an object
        const hitId = engineInstance.selectEntityAt(mx, my, rect.width, rect.height);
        if (hitId) {
            // Logic: If already selected, keep selection. If not, select it exclusively.
            if (!selectedIds.includes(hitId)) {
                onSelect([hitId]);
            }
            
            // Show Pie Menu
            setPieMenuState({ x: e.clientX, y: e.clientY, entityId: hitId });
            return; 
        }
        // If no hit, allow default context menu or show general menu (not implemented here)
        return;
    }

    // 3. Standard Tools & Selection (Left Click)
    if (!e.altKey && e.button === 0) {
        if (meshComponentMode !== 'OBJECT' && selectedIds.length > 0) {
            const result = engineInstance.pickMeshComponent(selectedIds[0], mx, my, rect.width, rect.height);
            // ... (Component picking logic omitted) ...
            return; 
        }

        // UNIFIED SELECTION LOGIC
        // Try to pick a single object
        const hitId = engineInstance.selectEntityAt(mx, my, rect.width, rect.height);
        
        if (hitId) {
             // Hit an object: Select it directly
             onSelect(e.shiftKey ? [...selectedIds, hitId] : [hitId]);
        } else {
             // Clicked Empty Space: Start Box Selection (Fallback for ALL tools)
             setSelectionBox({ startX: mx, startY: my, currentX: mx, currentY: my, isSelecting: true });
        }
    }
    
    // 4. Camera Navigation (Alt + Click or Middle/Right Drag)
    if (e.altKey || e.button === 1) {
        e.preventDefault();
        let mode: 'ORBIT' | 'PAN' | 'ZOOM' = 'ORBIT';
        if (e.button === 1 || (e.altKey && e.button === 1)) mode = 'PAN';
        if (e.button === 2 || (e.altKey && e.button === 2)) mode = 'ZOOM';
        
        setDragState({ isDragging: true, startX: e.clientX, startY: e.clientY, mode, startCamera: { ...camera } });
    }
  };

  // Global Mouse Move/Up Listener
  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      gizmoSystem.update(0, mx, my, rect.width, rect.height, false, false);

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
            const panSpeed = dragState.startCamera.radius * 0.002;
            const eyeX = dragState.startCamera.radius * Math.sin(dragState.startCamera.phi) * Math.cos(dragState.startCamera.theta);
            const eyeY = dragState.startCamera.radius * Math.cos(dragState.startCamera.phi);
            const eyeZ = dragState.startCamera.radius * Math.sin(dragState.startCamera.phi) * Math.sin(dragState.startCamera.theta);
            const forward = Vec3Utils.normalize(Vec3Utils.scale({x:eyeX,y:eyeY,z:eyeZ}, -1, {x:0,y:0,z:0}), {x:0,y:0,z:0});
            const worldUp = { x: 0, y: 1, z: 0 };
            const right = Vec3Utils.normalize(Vec3Utils.cross(forward, worldUp, {x:0,y:0,z:0}), {x:0,y:0,z:0});
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

    const handleWindowMouseUp = (e: MouseEvent) => {
        if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            gizmoSystem.update(0, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, false, true);
        }
        setDragState(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
        window.removeEventListener('mousemove', handleWindowMouseMove);
        window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [dragState, camera, selectionBox]);

  // Local Mouse Up: Commits Selection
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
            if (!e.shiftKey && e.button === 0) {
                onSelect([]);
            }
        }
        setSelectionBox(null);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
      // If pie menu is active (meaning we right-clicked an object), prevent default
      if (pieMenuState) {
          e.preventDefault();
      }
  };

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      const assetId = e.dataTransfer.getData('application/ti3d-asset');
      if (assetId && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          
          const invVP = new Float32Array(16);
          if (Mat4Utils.invert(vpMatrix, invVP)) {
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

  const handleModeSelect = (modeId: number) => { engineInstance.setRenderMode(modeId); setRenderMode(modeId); setIsViewMenuOpen(false); };

  return (
    <div ref={containerRef} className={`w-full h-full bg-[#151515] relative overflow-hidden select-none group/scene ${dragState ? (dragState.mode === 'PAN' ? 'cursor-move' : 'cursor-grabbing') : 'cursor-default'}`} 
         onMouseDown={handleMouseDown} 
         onMouseUp={handleMouseUp} 
         onDragOver={handleDragOver}
         onDrop={handleDrop}
         onWheel={(e) => setCamera(p => ({ ...p, radius: Math.max(2, p.radius + e.deltaY * 0.01) }))} 
         onContextMenu={handleContextMenu}
    >
        <canvas ref={canvasRef} className="block w-full h-full outline-none" />
        
        <StatsOverlay />
        
        {selectionBox && selectionBox.isSelecting && (
            <div className="absolute border border-blue-500 bg-blue-500/20 pointer-events-none z-30" style={{ left: Math.min(selectionBox.startX, selectionBox.currentX), top: Math.min(selectionBox.startY, selectionBox.currentY), width: Math.abs(selectionBox.currentX - selectionBox.startX), height: Math.abs(selectionBox.currentY - selectionBox.startY) }} />
        )}
        
        <div className="absolute top-3 left-3 flex gap-2 z-20">
            <div className="bg-black/40 backdrop-blur border border-white/5 rounded-md flex p-1 text-text-secondary">
                 <button className="p-1 hover:text-white rounded hover:bg-white/10" onClick={() => engineInstance.toggleGrid()} title="Toggle Grid" aria-label="Toggle Grid"><Icon name="Grid" size={14} /></button>
            </div>
            
            <div className="relative" ref={viewMenuRef}>
                <div className="bg-black/40 backdrop-blur border border-white/5 rounded-md flex items-center px-2 py-1 text-[10px] text-text-secondary min-w-[100px] justify-between cursor-pointer hover:bg-white/5 group" onClick={() => setIsViewMenuOpen(!isViewMenuOpen)}>
                    <div className="flex items-center gap-2"><Icon name={(VIEW_MODES.find(m => m.id === renderMode) || VIEW_MODES[0]).icon as any} size={12} className="text-accent" /><span className="font-semibold text-white/90">{(VIEW_MODES.find(m => m.id === renderMode) || VIEW_MODES[0]).label}</span></div>
                    <Icon name="ChevronDown" size={10} className={`text-text-secondary transition-transform ${isViewMenuOpen ? 'rotate-180' : ''}`} />
                </div>
                {isViewMenuOpen && (
                    <div className="absolute top-full left-0 mt-1 w-32 bg-[#252525] border border-white/10 rounded-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 z-50">
                        {VIEW_MODES.map((mode) => (
                            <button key={mode.id} onClick={() => handleModeSelect(mode.id)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-accent hover:text-white transition-colors text-left ${mode.id === renderMode ? 'bg-white/5 text-white font-bold' : 'text-text-secondary'}`}><Icon name={mode.icon as any} size={12} /><span>{mode.label}</span>{mode.id === renderMode && <Icon name="Check" size={10} className="ml-auto" />}</button>
                        ))}
                    </div>
                )}
            </div>

            {meshComponentMode !== 'OBJECT' && (
                <div className="bg-accent/20 backdrop-blur border border-accent/40 rounded-md flex items-center px-3 py-1 text-[10px] text-accent font-bold uppercase tracking-widest animate-pulse">
                    Selection Mode: {meshComponentMode}
                </div>
            )}
        </div>
        <div className="absolute bottom-2 right-2 text-[10px] text-text-secondary bg-black/40 px-2 py-0.5 rounded backdrop-blur border border-white/5 z-20">Cam: {camera.target.x.toFixed(1)}, {camera.target.y.toFixed(1)}, {camera.target.z.toFixed(1)}</div>

        {pieMenuState && createPortal(
            <PieMenu 
                x={pieMenuState.x} 
                y={pieMenuState.y}
                entityId={pieMenuState.entityId}
                currentMode={meshComponentMode}
                onSelectMode={(m) => { setMeshComponentMode(m); setPieMenuState(null); }}
                onAction={(a) => {
                    const targetId = pieMenuState.entityId;
                    if(a === 'delete') {
                        // Action applies to ALL selected items if multiple are selected
                        selectedIds.forEach(id => engineInstance.deleteEntity(id, sceneGraph));
                        onSelect([]);
                    }
                    if(a === 'duplicate') {
                        // Action applies to ALL selected items
                        selectedIds.forEach(id => engineInstance.duplicateEntity(id));
                    }
                    if(a === 'focus') {
                        // Focus on the SELECTION group, not just the clicked item (unless it's the only one)
                        handleFocus();
                    }
                    setPieMenuState(null);
                }}
                onClose={() => setPieMenuState(null)}
            />, 
            document.body
        )}
    </div>
  );
};
