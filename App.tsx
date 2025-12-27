
import React, { useState, useEffect, useCallback, useContext, useRef, useMemo } from 'react';
import { engineInstance } from './services/engine';
import { Entity, ToolType, TransformSpace, SelectionType, GraphNode, GraphConnection, MeshComponentMode } from './types';
import { EditorContext, EditorContextType, DEFAULT_UI_CONFIG, UIConfiguration, GridConfiguration, DEFAULT_GRID_CONFIG, SnapSettings, DEFAULT_SNAP_CONFIG } from './contexts/EditorContext';
import { assetManager } from './services/AssetManager';
import { consoleService } from './services/Console';

// Components
import { Toolbar } from './components/Toolbar';
import { HierarchyPanel } from './components/HierarchyPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { SceneView } from './components/SceneView';
import { ProjectPanel } from './components/ProjectPanel';
import { ConsolePanel } from './components/ConsolePanel'; // New Import
import { Icon } from './components/Icon';
import { PreferencesModal } from './components/PreferencesModal';
import { WindowManager, WindowManagerContext } from './components/WindowManager';
import { GeometrySpreadsheet } from './components/GeometrySpreadsheet';
import { UVEditor } from './components/UVEditor';
import { Timeline } from './components/Timeline';
import { SkinningEditor } from './components/SkinningEditor';

// --- Widget Wrappers ---

const HierarchyWrapper = () => {
  const ctx = useContext(EditorContext);
  if (!ctx) return null;
  return (
    <HierarchyPanel 
      entities={ctx.entities} 
      sceneGraph={ctx.sceneGraph}
      selectedIds={ctx.selectedIds}
      onSelect={(ids) => {
          ctx.setSelectedIds(ids);
          ctx.setSelectionType('ENTITY');
      }}
    />
  );
};

const InspectorWrapper = () => {
  const ctx = useContext(EditorContext);
  if (!ctx) return null;
  
  let target: any = null;
  let count = 0;

  if (ctx.inspectedNode) {
      target = ctx.inspectedNode;
      return <InspectorPanel object={target} type="NODE" />;
  }

  if (ctx.selectionType === 'ENTITY') {
      if (ctx.selectedIds.length > 0) {
          target = ctx.entities.find(e => e.id === ctx.selectedIds[0]) || null;
          count = ctx.selectedIds.length;
      }
  } else if (ctx.selectionType === 'ASSET') {
      if (ctx.selectedAssetIds.length > 0) {
          target = assetManager.getAsset(ctx.selectedAssetIds[0]) || null;
          count = ctx.selectedAssetIds.length;
      }
  }

  return <InspectorPanel object={target} selectionCount={count} type={ctx.selectionType} />;
};

const SceneWrapper = () => {
  const ctx = useContext(EditorContext);
  if (!ctx) return null;
  return (
    <SceneView 
      entities={ctx.entities}
      sceneGraph={ctx.sceneGraph}
      selectedIds={ctx.selectedIds}
      onSelect={(ids) => {
          ctx.setSelectedIds(ids);
          ctx.setSelectionType('ENTITY');
      }}
      tool={ctx.tool}
    />
  );
};

const ProjectWrapper = () => <ProjectPanel />;
const ConsoleWrapper = () => <ConsolePanel />;

const StatsContent = () => {
    const [metrics, setMetrics] = useState(engineInstance.metrics);
    useEffect(() => {
        const i = setInterval(() => setMetrics({ ...engineInstance.metrics }), 500);
        return () => clearInterval(i);
    }, []);

    return (
        <div className="p-4 space-y-3 bg-transparent">
            <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 bg-black/30 rounded border border-white/5">
                    <div className="text-text-secondary">FPS</div>
                    <div className="text-lg font-mono text-emerald-400">{metrics.fps.toFixed(0)}</div>
                </div>
                <div className="p-2 bg-black/30 rounded border border-white/5">
                    <div className="text-text-secondary">Frame Time</div>
                    <div className="text-lg font-mono text-blue-400">{metrics.frameTime.toFixed(2)}ms</div>
                </div>
                <div className="p-2 bg-black/30 rounded border border-white/5">
                    <div className="text-text-secondary">Draw Calls</div>
                    <div className="text-lg font-mono text-orange-400">{metrics.drawCalls}</div>
                </div>
                <div className="p-2 bg-black/30 rounded border border-white/5">
                    <div className="text-text-secondary">Entities</div>
                    <div className="text-lg font-mono text-white">{metrics.entityCount}</div>
                </div>
            </div>
        </div>
    );
};

const EditorInterface: React.FC = () => {
    const wm = useContext(WindowManagerContext);
    const editor = useContext(EditorContext);
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        if (!wm) return;

        wm.registerWindow({
            id: 'hierarchy', title: 'Hierarchy', icon: 'ListTree', content: <HierarchyWrapper />, 
            width: 280, height: 500, initialPosition: { x: 80, y: 100 }
        });
        wm.registerWindow({
            id: 'inspector', title: 'Inspector', icon: 'Settings2', content: <InspectorWrapper />, 
            width: 320, height: 600, initialPosition: { x: window.innerWidth - 340, y: 100 }
        });
        wm.registerWindow({
            id: 'project', title: 'Project Browser', icon: 'FolderOpen', content: <ProjectWrapper />, 
            width: 600, height: 350, initialPosition: { x: 380, y: window.innerHeight - 370 }
        });
        wm.registerWindow({
            id: 'console', title: 'Console', icon: 'Terminal', content: <ConsoleWrapper />, 
            width: 500, height: 250, initialPosition: { x: 80, y: window.innerHeight - 270 }
        });
        wm.registerWindow({
            id: 'spreadsheet', title: 'Geometry Spreadsheet', icon: 'Table', content: <GeometrySpreadsheet />, 
            width: 550, height: 400, initialPosition: { x: 450, y: window.innerHeight - 450 }
        });
        wm.registerWindow({
            id: 'preferences', title: 'Preferences', icon: 'Settings', content: <PreferencesModal onClose={() => wm.closeWindow('preferences')} />, 
            width: 500
        });
        wm.registerWindow({
            id: 'stats', title: 'Performance', icon: 'Activity', content: <StatsContent />, 
            width: 280, initialPosition: { x: window.innerWidth - 300, y: 60 }
        });
        wm.registerWindow({
            id: 'uveditor', title: 'UV Editor', icon: 'LayoutGrid', content: <UVEditor />, 
            width: 500, height: 500, initialPosition: { x: 200, y: 200 }
        });
        wm.registerWindow({
            id: 'skinning', title: 'Skinning Editor', icon: 'PersonStanding', content: <SkinningEditor />, 
            width: 300, height: 400, initialPosition: { x: window.innerWidth - 650, y: 100 }
        });
        wm.registerWindow({
            id: 'timeline', title: 'Timeline', icon: 'Film', content: <Timeline />, 
            width: window.innerWidth - 450, height: 200, initialPosition: { x: 400, y: window.innerHeight - 220 }
        });

        if (!initialized.current) {
            wm.openWindow('hierarchy');
            wm.openWindow('inspector');
            wm.openWindow('project');
            wm.openWindow('timeline');
            consoleService.init(); // Initialize global error catching
            initialized.current = true;
        }
    }, [wm]);

    // Keyboard Shortcuts (Delete Object)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const active = document.activeElement;
                const isInput = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA';
                if (!isInput && editor?.selectedIds.length && editor.selectionType === 'ENTITY') {
                    e.preventDefault();
                    editor.selectedIds.forEach(id => engineInstance.deleteEntity(id, engineInstance.sceneGraph));
                    editor.setSelectedIds([]);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [editor?.selectedIds, editor?.selectionType]);

    if (!editor) return <div className="flex h-screen items-center justify-center text-white">Initializing...</div>;

    const toggleMenu = (e: React.MouseEvent, menu: string) => {
        e.stopPropagation();
        setActiveMenu(activeMenu === menu ? null : menu);
    };

    const handleLoad = () => {
        const json = localStorage.getItem('ti3d_scene');
        if (json) {
            engineInstance.loadScene(json);
            consoleService.success("Scene Loaded Successfully", "System");
        } else {
            consoleService.warn("No saved scene found in local storage.", "System");
        }
    };

    const handleSave = () => {
        const json = engineInstance.saveScene();
        localStorage.setItem('ti3d_scene', json);
        consoleService.success("Scene Saved", "System");
    };

    return (
        <div className="flex flex-col h-screen bg-[#101010] text-text-primary overflow-hidden font-sans relative" onClick={() => setActiveMenu(null)}>
            <div className="flex flex-col z-50 pointer-events-auto shadow-xl">
                <div className="h-8 bg-panel-header flex items-center px-3 text-[11px] select-none border-b border-white/5 gap-4">
                    <div className="font-bold text-white tracking-wide flex items-center gap-2 pr-4 border-r border-white/5">
                        <div className="w-4 h-4 bg-accent rounded-sm shadow-[0_0_8px_rgba(79,128,248,0.6)]"></div>
                        Ti3D <span className="font-light text-white/40">PRO</span>
                    </div>
                    <div className="flex gap-2 text-text-primary relative">
                        <span className="hover:bg-white/10 px-2 py-1 rounded cursor-pointer transition-colors" onClick={(e) => toggleMenu(e, 'File')}>File</span>
                        {activeMenu === 'File' && (
                            <div className="absolute top-7 left-0 bg-[#252525] border border-white/10 shadow-2xl rounded-md py-1 min-w-[160px] text-text-primary z-[100]">
                                <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex justify-between" onClick={handleSave}><span>Save Scene</span><span className="text-white/30 text-[9px]">Ctrl+S</span></div>
                                <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer" onClick={handleLoad}>Load Scene</div>
                            </div>
                        )}
                        <span className="hover:bg-white/10 px-2 py-1 rounded cursor-pointer transition-colors" onClick={(e) => toggleMenu(e, 'Edit')}>Edit</span>
                        <div className="relative">
                            <span className={`hover:bg-white/10 px-2 py-1 rounded cursor-pointer transition-colors ${activeMenu === 'Window' ? 'bg-white/10' : ''}`} onClick={(e) => toggleMenu(e, 'Window')}>Window</span>
                            {activeMenu === 'Window' && (
                                <div className="absolute top-7 left-0 bg-[#252525] border border-white/10 shadow-2xl rounded-md py-1 min-w-[180px] text-text-primary z-[100]">
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('hierarchy'); setActiveMenu(null); }}>
                                        <Icon name="ListTree" size={12} /> Hierarchy
                                    </div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('inspector'); setActiveMenu(null); }}>
                                        <Icon name="Settings2" size={12} /> Inspector
                                    </div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('project'); setActiveMenu(null); }}>
                                        <Icon name="FolderOpen" size={12} /> Project
                                    </div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('console'); setActiveMenu(null); }}>
                                        <Icon name="Terminal" size={12} /> Console
                                    </div>
                                    <div className="border-t border-white/5 my-1"></div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('skinning'); setActiveMenu(null); }}>
                                        <Icon name="PersonStanding" size={12} /> Skinning Editor
                                    </div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('uveditor'); setActiveMenu(null); }}>
                                        <Icon name="LayoutGrid" size={12} /> UV Editor
                                    </div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('spreadsheet'); setActiveMenu(null); }}>
                                        <Icon name="Table" size={12} /> Spreadsheet
                                    </div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" onClick={() => { wm?.toggleWindow('timeline'); setActiveMenu(null); }}>
                                        <Icon name="Film" size={12} /> Timeline
                                    </div>
                                    <div className="border-t border-white/5 my-1"></div>
                                    <div className="px-4 py-1.5 hover:bg-accent hover:text-white cursor-pointer" onClick={() => { wm?.toggleWindow('preferences'); setActiveMenu(null); }}>Preferences...</div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <Toolbar 
                    isPlaying={editor.isPlaying}
                    onPlay={() => { engineInstance.start(); }}
                    onPause={() => { engineInstance.pause(); }}
                    onStop={() => { engineInstance.stop(); }}
                    currentTool={editor.tool}
                    setTool={editor.setTool}
                    transformSpace={editor.transformSpace}
                    setTransformSpace={editor.setTransformSpace}
                />
            </div>

            <div className="absolute inset-0 top-[64px] bottom-[24px] z-0">
                <SceneWrapper />
            </div>

            <div className="absolute bottom-0 w-full h-6 bg-panel-header/90 backdrop-blur flex items-center px-4 justify-between text-[10px] text-text-secondary shrink-0 select-none z-50 border-t border-white/5">
                <div className="flex items-center gap-4">
                    {editor.isPlaying ? <span className="text-emerald-500 animate-pulse font-bold">● PLAYING</span> : <span>Ready</span>}
                </div>
                <div className="flex items-center gap-4 font-mono opacity-60">
                    <span>{engineInstance.metrics.entityCount} Objects</span>
                    <span>{engineInstance.metrics.fps.toFixed(0)} FPS</span>
                </div>
            </div>
        </div>
    );
};

const App: React.FC = () => {
    const [entities, setEntities] = useState<Entity[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [selectionType, setSelectionType] = useState<SelectionType>('ENTITY');
    const [tool, setTool] = useState<ToolType>('SELECT');
    const [transformSpace, setTransformSpace] = useState<TransformSpace>('World');
    const [meshComponentMode, setMeshComponentMode] = useState<MeshComponentMode>('OBJECT');
    
    // Graph
    const [inspectedNode, setInspectedNode] = useState<GraphNode | null>(null);
    const [activeGraphConnections, setActiveGraphConnections] = useState<GraphConnection[]>([]);
    
    // Configs
    const [uiConfig, setUiConfig] = useState<UIConfiguration>(DEFAULT_UI_CONFIG);
    const [gridConfig, setGridConfig] = useState<GridConfiguration>(DEFAULT_GRID_CONFIG);
    const [snapSettings, setSnapSettings] = useState<SnapSettings>(DEFAULT_SNAP_CONFIG);

    const onNodeDataChangeRef = useRef<((nodeId: string, key: string, value: any) => void) | null>(null);

    useEffect(() => {
        const update = () => {
            setEntities(engineInstance.ecs.getAllProxies(engineInstance.sceneGraph));
        };
        update();
        return engineInstance.subscribe(update);
    }, []);

    useEffect(() => { engineInstance.setGridConfig(gridConfig); }, [gridConfig]);
    useEffect(() => { engineInstance.setUiConfig(uiConfig); }, [uiConfig]);

    const contextValue = useMemo<EditorContextType>(() => ({
        entities,
        sceneGraph: engineInstance.sceneGraph,
        selectedIds,
        setSelectedIds: (ids) => { setSelectedIds(ids); engineInstance.setSelected(ids); },
        selectedAssetIds,
        setSelectedAssetIds,
        inspectedNode,
        setInspectedNode,
        activeGraphConnections,
        setActiveGraphConnections,
        updateInspectedNodeData: (key, value) => {
            if (inspectedNode) {
                setInspectedNode(prev => prev ? { ...prev, data: { ...prev.data, [key]: value } } : null);
            }
        },
        onNodeDataChange: (nodeId, key, value) => {
            if (onNodeDataChangeRef.current) onNodeDataChangeRef.current(nodeId, key, value);
        },
        setOnNodeDataChange: (cb) => { onNodeDataChangeRef.current = cb; },
        selectionType,
        setSelectionType,
        meshComponentMode,
        setMeshComponentMode,
        tool,
        setTool,
        transformSpace,
        setTransformSpace,
        isPlaying: engineInstance.isPlaying,
        uiConfig,
        setUiConfig,
        gridConfig,
        setGridConfig,
        snapSettings,
        setSnapSettings
    }), [
        entities, selectedIds, selectedAssetIds, inspectedNode, activeGraphConnections, 
        selectionType, meshComponentMode, tool, transformSpace, uiConfig, gridConfig, 
        snapSettings, engineInstance.isPlaying
    ]);

    return (
        <EditorContext.Provider value={contextValue}>
            <WindowManager>
                <EditorInterface />
            </WindowManager>
        </EditorContext.Provider>
    );
};

export default App;
