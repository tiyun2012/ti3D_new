
import React, { useState, useContext, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { assetManager, RIG_TEMPLATES } from '../services/AssetManager';
import { EditorContext } from '../contexts/EditorContext';
import { WindowManagerContext } from './WindowManager';
import { MATERIAL_TEMPLATES } from '../services/MaterialTemplates';
import { engineInstance } from '../services/engine';
import { NodeGraph } from './NodeGraph'; 
import { ImportWizard } from './ImportWizard';
import { consoleService, LogEntry, LogType } from '../services/Console';

interface ProjectPanelProps {
    initialTab?: 'PROJECT' | 'CONSOLE';
}

export const ProjectPanel: React.FC<ProjectPanelProps> = ({ initialTab = 'PROJECT' }) => {
    const [tab, setTab] = useState<'PROJECT' | 'CONSOLE'>(initialTab);
    const [filter, setFilter] = useState<'ALL' | 'MESH' | 'SKELETAL_MESH' | 'MATERIAL' | 'PHYSICS_MATERIAL' | 'SCRIPT' | 'RIG'>('ALL');
    const [search, setSearch] = useState('');
    const [scale, setScale] = useState(40);
    const { setSelectedAssetIds, selectedAssetIds, setSelectionType } = useContext(EditorContext)!;
    const wm = useContext(WindowManagerContext);
    
    const [showCreateMenu, setShowCreateMenu] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, assetId: string, visible: boolean } | null>(null);
    const [refresh, setRefresh] = useState(0);
    
    // Console State
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [logFilter, setLogFilter] = useState<'ALL' | 'ERROR' | 'WARN' | 'INFO'>('ALL');
    const [logSearch, setLogSearch] = useState('');
    const logsEndRef = useRef<HTMLDivElement>(null);

    const allAssets = assetManager.getAllAssets();
    const filteredAssets = allAssets.filter(a => {
        if (filter !== 'ALL' && a.type !== filter) return false;
        if (!a.name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const filteredLogs = logs.filter(l => {
        if (logFilter === 'ERROR' && l.type !== 'error') return false;
        if (logFilter === 'WARN' && l.type !== 'warn') return false;
        if (logFilter === 'INFO' && (l.type === 'error' || l.type === 'warn')) return false;
        if (logSearch && !l.message.toLowerCase().includes(logSearch.toLowerCase())) return false;
        return true;
    });

    useEffect(() => {
        const unsubscribe = consoleService.subscribe(() => {
            setLogs([...consoleService.getLogs()]);
        });
        setLogs([...consoleService.getLogs()]); 
        return unsubscribe;
    }, []);

    useEffect(() => {
        if (tab === 'CONSOLE' && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, tab, logFilter]);

    useEffect(() => {
        const close = () => { setShowCreateMenu(false); setContextMenu(null); };
        window.addEventListener('click', close);
        window.addEventListener('contextmenu', (e) => {
            setContextMenu(null); 
        });
        return () => {
            window.removeEventListener('click', close);
        };
    }, [contextMenu]);

    const handleDragStart = (e: React.DragEvent, assetId: string) => {
        e.dataTransfer.setData('application/ti3d-asset', assetId);
        e.dataTransfer.effectAllowed = 'copy';
    };

    const handleClick = (assetId: string) => {
        setSelectedAssetIds([assetId]);
        setSelectionType('ASSET');
    };

    const openAssetEditor = (assetId: string) => {
        const asset = assetManager.getAsset(assetId);
        if (asset && (asset.type === 'MATERIAL' || asset.type === 'SCRIPT' || asset.type === 'RIG')) {
            const winId = `graph_${assetId}`;
            wm?.registerWindow({
                id: winId,
                title: `${asset.name}`,
                icon: asset.type === 'RIG' ? 'GitBranch' : (asset.type === 'SCRIPT' ? 'FileCode' : 'Palette'),
                content: <NodeGraph assetId={assetId} />,
                width: 900,
                height: 600,
                initialPosition: { 
                    x: 150 + (Math.random() * 50), 
                    y: 100 + (Math.random() * 50) 
                }
            });
            wm?.openWindow(winId);
        }
    };

    const handleDoubleClick = (assetId: string) => {
        openAssetEditor(assetId);
    };

    const handleContextMenu = (e: React.MouseEvent, assetId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, assetId, visible: true });
        handleClick(assetId);
    };

    const createMaterial = (templateIndex?: number) => {
        const tpl = templateIndex !== undefined ? MATERIAL_TEMPLATES[templateIndex] : undefined;
        const asset = assetManager.createMaterial(`New Material ${Math.floor(Math.random() * 1000)}`, tpl);
        setRefresh(r => r + 1);
        consoleService.success(`Created Material: ${asset.name}`);
    };

    const createPhysicsMaterial = () => {
        assetManager.createPhysicsMaterial(`New Physics Mat ${Math.floor(Math.random() * 1000)}`);
        setRefresh(r => r + 1);
    };

    const createScript = () => {
        const asset = assetManager.createScript(`New Visual Script ${Math.floor(Math.random() * 1000)}`);
        setRefresh(r => r + 1);
        openAssetEditor(asset.id);
    };

    const createRig = (templateIndex?: number) => {
        const tpl = templateIndex !== undefined ? RIG_TEMPLATES[templateIndex] : undefined;
        const asset = assetManager.createRig(`New Rig ${Math.floor(Math.random() * 1000)}`, tpl);
        setRefresh(r => r + 1);
        openAssetEditor(asset.id);
    };

    const openImportWizard = () => {
        const winId = 'import_wizard';
        wm?.registerWindow({
            id: winId,
            title: 'Import Asset',
            icon: 'Import',
            content: <ImportWizard onClose={() => wm.closeWindow(winId)} onImportSuccess={(id) => { 
                setRefresh(r=>r+1); 
                wm.closeWindow(winId); 
                consoleService.success("Asset Imported Successfully");
            }} />,
            width: 400,
            height: 500,
            initialPosition: { x: window.innerWidth/2 - 200, y: window.innerHeight/2 - 250 }
        });
        wm?.openWindow(winId);
    };

    const duplicateAsset = (id: string) => {
        const newAsset = assetManager.duplicateAsset(id);
        if (newAsset) {
            setRefresh(r => r + 1);
            consoleService.info(`Duplicated asset: ${newAsset.name}`);
        }
    };

    const deleteAsset = (id: string) => {
        engineInstance.deleteAsset(id);
        setSelectedAssetIds([]);
        setRefresh(r => r + 1);
        consoleService.warn("Deleted asset");
    };

    const applyMaterial = (assetId: string) => {
        engineInstance.applyMaterialToSelected(assetId);
        consoleService.info(`Applied material to selection`);
    };

    const renderLogIcon = (type: LogType) => {
        switch(type) {
            case 'error': return <Icon name="AlertCircle" size={14} className="text-red-500" />;
            case 'warn': return <Icon name="AlertTriangle" size={14} className="text-yellow-500" />;
            case 'success': return <Icon name="CheckCircle2" size={14} className="text-green-500" />;
            default: return <Icon name="Info" size={14} className="text-blue-400" />;
        }
    };

    return (
        <div className="h-full bg-panel flex flex-col font-sans border-t border-black/20" onContextMenu={(e) => e.preventDefault()}>
            <div className="flex items-center justify-between bg-panel-header px-2 py-1 border-b border-black/20">
                <div className="flex gap-2">
                    <button 
                        onClick={() => setTab('PROJECT')}
                        className={`text-xs px-3 py-1 rounded-t-md transition-colors ${tab === 'PROJECT' ? 'bg-panel text-white border-t border-x border-black/10 font-bold' : 'text-text-secondary hover:text-white'}`}
                    >
                        Project
                    </button>
                    <button 
                        onClick={() => setTab('CONSOLE')}
                        className={`text-xs px-3 py-1 rounded-t-md transition-colors flex items-center gap-2 ${tab === 'CONSOLE' ? 'bg-panel text-white border-t border-x border-black/10 font-bold' : 'text-text-secondary hover:text-white'}`}
                    >
                        Console 
                        {logs.filter(l => l.type === 'error').length > 0 && (
                            <span className="bg-red-500 text-white text-[9px] px-1.5 rounded-full">{logs.filter(l => l.type === 'error').length}</span>
                        )}
                        {logs.filter(l => l.type === 'warn').length > 0 && (
                            <span className="bg-yellow-500 text-black text-[9px] px-1.5 rounded-full">{logs.filter(l => l.type === 'warn').length}</span>
                        )}
                    </button>
                </div>
                
                {tab === 'PROJECT' && (
                    <div className="flex items-center gap-2">
                        <button 
                            onClick={openImportWizard}
                            className="bg-accent/80 hover:bg-accent text-white px-3 py-1 rounded text-xs flex items-center gap-1 shadow-sm transition-colors"
                            title="Import External Asset"
                        >
                            <Icon name="Import" size={14} />
                            <span>Import</span>
                        </button>

                        <div className="h-4 w-px bg-white/10 mx-2"></div>

                        <div className="relative">
                            <button 
                                onClick={(e) => { e.stopPropagation(); setShowCreateMenu(!showCreateMenu); }}
                                className={`p-1 hover:bg-white/10 rounded flex items-center gap-1 transition-colors ${showCreateMenu ? 'bg-white/10 text-white' : 'text-emerald-500'}`}
                                title="Create Asset"
                            >
                                <Icon name="PlusSquare" size={16} />
                                <span className="text-xs font-bold">Add</span>
                                <Icon name="ChevronDown" size={10} />
                            </button>
                            
                            {showCreateMenu && (
                                <div className="absolute top-full right-0 mt-1 w-40 bg-[#252525] border border-white/10 shadow-xl rounded z-50 py-1 text-xs">
                                    <div className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer" onClick={() => createScript()}>
                                        Visual Script
                                    </div>
                                    <div className="border-t border-white/10 my-1"></div>
                                    <div className="px-3 py-1 text-[9px] text-text-secondary uppercase font-bold tracking-wider opacity-50">Rig Graphs</div>
                                    {RIG_TEMPLATES.map((tpl, i) => (
                                        <div key={i} className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer" onClick={() => createRig(i)}>
                                            {tpl.name}
                                        </div>
                                    ))}
                                    <div className="border-t border-white/10 my-1"></div>
                                    <div className="px-3 py-1 text-[9px] text-text-secondary uppercase font-bold tracking-wider opacity-50">Materials</div>
                                    {MATERIAL_TEMPLATES.map((tpl, i) => (
                                        <div key={i} className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer" onClick={() => createMaterial(i)}>
                                            {tpl.name}
                                        </div>
                                    ))}
                                    <div className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer" onClick={() => createPhysicsMaterial()}>
                                        Physics Material
                                    </div>
                                </div>
                            )}
                        </div>

                        <input 
                            type="range" min="30" max="80" 
                            value={scale} onChange={(e) => setScale(Number(e.target.value))}
                            className="w-16 opacity-50 hover:opacity-100"
                            aria-label="Asset Scale"
                        />
                        <div className="relative">
                            <Icon name="Search" size={12} className="absolute left-2 top-1.5 text-text-secondary" />
                            <input 
                                type="text" 
                                placeholder="Search..." 
                                aria-label="Search Assets"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="bg-input-bg text-xs py-1 pl-7 pr-2 rounded-full outline-none border border-transparent focus:border-accent text-white w-40" 
                            />
                        </div>
                    </div>
                )}
                
                {tab === 'CONSOLE' && (
                    <div className="flex items-center gap-2">
                        <div className="flex bg-black/40 rounded p-0.5 border border-white/5">
                            <button onClick={() => setLogFilter('ALL')} className={`px-2 py-0.5 text-[10px] rounded ${logFilter === 'ALL' ? 'bg-white/20 text-white' : 'text-text-secondary hover:text-white'}`}>All</button>
                            <button onClick={() => setLogFilter('ERROR')} className={`px-2 py-0.5 text-[10px] rounded ${logFilter === 'ERROR' ? 'bg-red-500/20 text-red-400' : 'text-text-secondary hover:text-white'}`}>Errors</button>
                            <button onClick={() => setLogFilter('WARN')} className={`px-2 py-0.5 text-[10px] rounded ${logFilter === 'WARN' ? 'bg-yellow-500/20 text-yellow-400' : 'text-text-secondary hover:text-white'}`}>Warnings</button>
                        </div>
                        <div className="relative">
                            <input 
                                type="text" 
                                placeholder="Filter Log..." 
                                className="bg-input-bg text-[10px] py-1 px-2 rounded border border-transparent focus:border-accent text-white w-32 outline-none"
                                value={logSearch}
                                onChange={(e) => setLogSearch(e.target.value)}
                            />
                        </div>
                        <button 
                            onClick={() => consoleService.clear()}
                            className="text-xs px-2 py-1 hover:bg-white/10 rounded text-text-secondary hover:text-white border border-white/5"
                            title="Clear Console"
                        >
                            Clear
                        </button>
                    </div>
                )}
            </div>

            {tab === 'PROJECT' && (
                <div className="bg-panel flex items-center gap-2 px-3 py-1.5 text-xs border-b border-black/10 overflow-x-auto">
                    <button onClick={() => setFilter('ALL')} className={`hover:text-white whitespace-nowrap ${filter === 'ALL' ? 'text-white font-bold' : 'text-text-secondary'}`}>All</button>
                    <span className="text-white/10">|</span>
                    <button onClick={() => setFilter('SKELETAL_MESH')} className={`hover:text-white whitespace-nowrap ${filter === 'SKELETAL_MESH' ? 'text-white font-bold' : 'text-text-secondary'}`}>Skeletal</button>
                    <span className="text-white/10">|</span>
                    <button onClick={() => setFilter('RIG')} className={`hover:text-white whitespace-nowrap ${filter === 'RIG' ? 'text-white font-bold' : 'text-text-secondary'}`}>Rigs</button>
                    <span className="text-white/10">|</span>
                    <button onClick={() => setFilter('SCRIPT')} className={`hover:text-white whitespace-nowrap ${filter === 'SCRIPT' ? 'text-white font-bold' : 'text-text-secondary'}`}>Scripts</button>
                    <span className="text-white/10">|</span>
                    <button onClick={() => setFilter('MATERIAL')} className={`hover:text-white whitespace-nowrap ${filter === 'MATERIAL' ? 'text-white font-bold' : 'text-text-secondary'}`}>Materials</button>
                    <span className="text-white/10">|</span>
                    <button onClick={() => setFilter('MESH')} className={`hover:text-white whitespace-nowrap ${filter === 'MESH' ? 'text-white font-bold' : 'text-text-secondary'}`}>Static</button>
                    <span className="text-white/10">|</span>
                    <button onClick={() => setFilter('PHYSICS_MATERIAL')} className={`hover:text-white whitespace-nowrap ${filter === 'PHYSICS_MATERIAL' ? 'text-white font-bold' : 'text-text-secondary'}`}>Physics</button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-2 bg-[#1a1a1a]">
                {tab === 'PROJECT' && (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-2 pb-20">
                        {filteredAssets.map((asset) => {
                            const isMat = asset.type === 'MATERIAL';
                            const isPhys = asset.type === 'PHYSICS_MATERIAL';
                            const isScript = asset.type === 'SCRIPT';
                            const isRig = asset.type === 'RIG';
                            const isSkel = asset.type === 'SKELETAL_MESH';
                            const isSelected = selectedAssetIds.includes(asset.id);
                            
                            let iconName = 'Box';
                            let color = 'text-accent';
                            if (isMat) { iconName = 'Palette'; color = 'text-pink-500'; }
                            else if (isPhys) { iconName = 'Activity'; color = 'text-green-500'; }
                            else if (isScript) { iconName = 'FileCode'; color = 'text-yellow-500'; }
                            else if (isRig) { iconName = 'GitBranch'; color = 'text-orange-500'; }
                            else if (isSkel) { iconName = 'PersonStanding'; color = 'text-purple-500'; }

                            return (
                                <div 
                                    key={asset.id} 
                                    className={`flex flex-col items-center group cursor-pointer p-2 rounded-md transition-colors border active:bg-white/20 relative
                                        ${isSelected ? 'bg-accent/20 border-accent' : 'hover:bg-white/10 border-transparent hover:border-white/5'}
                                    `}
                                    draggable={asset.type === 'MESH' || asset.type === 'SKELETAL_MESH'} 
                                    onDragStart={(e) => (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') && handleDragStart(e, asset.id)}
                                    onClick={() => handleClick(asset.id)}
                                    onDoubleClick={() => handleDoubleClick(asset.id)}
                                    onContextMenu={(e) => handleContextMenu(e, asset.id)}
                                >
                                    <div 
                                        className="flex items-center justify-center bg-black/20 rounded mb-2 shadow-inner"
                                        style={{ width: scale, height: scale }}
                                    >
                                        <Icon 
                                            name={iconName as any} 
                                            size={scale * 0.6} 
                                            className={`${color} drop-shadow-md transition-transform group-hover:scale-110`} 
                                        />
                                    </div>
                                    <span className={`text-[10px] text-center w-full break-words leading-tight select-none
                                        ${isSelected ? 'text-white font-bold' : 'text-text-secondary group-hover:text-white'}
                                    `}>
                                        {asset.name}
                                    </span>
                                    <div className="text-[8px] text-text-secondary opacity-0 group-hover:opacity-50 mt-1 uppercase tracking-wider">
                                        {asset.type.replace('_', ' ')}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                {tab === 'CONSOLE' && (
                    <div className="font-mono text-xs space-y-0.5 pb-10">
                        {filteredLogs.length === 0 && <div className="text-text-secondary italic p-2 opacity-50">Console is empty.</div>}
                        {filteredLogs.map((log) => (
                            <div key={log.id} className="flex items-start gap-2 py-1 px-2 hover:bg-white/5 border-b border-white/5 group">
                                <div className="mt-0.5 shrink-0 opacity-70">
                                    {renderLogIcon(log.type)}
                                </div>
                                <div className="flex-1 break-all">
                                    <span className="text-[10px] text-white/30 mr-2">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                    {log.source && <span className="text-[10px] text-white/50 mr-2 uppercase font-bold tracking-wider">[{log.source}]</span>}
                                    <span className={log.type === 'error' ? 'text-red-400' : (log.type === 'warn' ? 'text-yellow-400' : (log.type === 'success' ? 'text-emerald-400' : 'text-text-primary'))}>
                                        {log.message}
                                    </span>
                                    {log.count > 1 && (
                                        <span className="ml-2 bg-white/10 text-white px-1.5 rounded-full text-[9px] font-bold">{log.count}</span>
                                    )}
                                </div>
                            </div>
                        ))}
                        <div ref={logsEndRef} />
                    </div>
                )}
            </div>

            {contextMenu && contextMenu.visible && createPortal(
                <div 
                    className="fixed bg-[#252525] border border-white/10 shadow-2xl rounded py-1 min-w-[160px] text-xs"
                    style={{ 
                        position: 'fixed',
                        left: `${Math.min(contextMenu.x + 2, window.innerWidth - 160)}px`, 
                        top: `${Math.min(contextMenu.y + 2, window.innerHeight - 150)}px`,
                        zIndex: 99999
                    }}
                    onClick={(e) => e.stopPropagation()} 
                    onContextMenu={(e) => e.preventDefault()}
                >
                    {(assetManager.getAsset(contextMenu.assetId)?.type === 'MATERIAL' || 
                      assetManager.getAsset(contextMenu.assetId)?.type === 'PHYSICS_MATERIAL' || 
                      assetManager.getAsset(contextMenu.assetId)?.type === 'SCRIPT' ||
                      assetManager.getAsset(contextMenu.assetId)?.type === 'RIG') && (
                        <>
                            <div className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2"
                                onClick={() => { openAssetEditor(contextMenu.assetId); setContextMenu(null); }}>
                                <Icon name="Workflow" size={12} /> Open Graph
                            </div>
                            {assetManager.getAsset(contextMenu.assetId)?.type === 'MATERIAL' && (
                                <div className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" 
                                    onClick={() => { applyMaterial(contextMenu.assetId); setContextMenu(null); }}>
                                    <Icon name="Stamp" size={12} /> Apply to Selected
                                </div>
                            )}
                            <div className="px-3 py-1.5 hover:bg-accent hover:text-white cursor-pointer flex items-center gap-2" 
                                onClick={() => { duplicateAsset(contextMenu.assetId); setContextMenu(null); }}>
                                <Icon name="Copy" size={12} /> Duplicate
                            </div>
                            <div className="border-t border-white/10 my-1"></div>
                        </>
                    )}
                    
                    {/* Only show Delete if the asset is not protected (e.g. not a system primitive) */}
                    {!assetManager.getAsset(contextMenu.assetId)?.isProtected && (
                        <div className="px-3 py-1.5 hover:bg-red-500/20 hover:text-red-400 cursor-pointer flex items-center gap-2"
                            onClick={() => { deleteAsset(contextMenu.assetId); setContextMenu(null); }}>
                            <Icon name="Trash2" size={12} /> Delete
                        </div>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
};
