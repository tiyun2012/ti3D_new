
import React, { useState, useRef, useEffect, useContext } from 'react';
import { Entity, Asset, PhysicsMaterialAsset, GraphNode, ComponentType, SelectionType } from '../types';
import { engineInstance } from '../services/engine';
import { assetManager } from '../services/AssetManager';
import { Icon } from './Icon';
import { EditorContext } from '../contexts/EditorContext';
import { Select } from './ui/Select';
import { NodeRegistry } from '../services/NodeRegistry';
import { WindowManagerContext } from './WindowManager';
import { moduleManager } from '../services/ModuleManager';

interface InspectorPanelProps {
  object: Entity | Asset | GraphNode | null;
  selectionCount?: number;
  type?: SelectionType;
  isClone?: boolean;
}

// --- Reusable UI Control (Moved DraggableNumber local here for non-module usage if needed, or keeping for asset inspector) ---
const DraggableNumber: React.FC<{ 
  label: string; value: number; onChange: (val: number) => void; step?: number; 
}> = ({ label, value, onChange, step = 0.1 }) => {
  // Simplified for Asset Inspector usage
  return (
    <div className="flex items-center bg-input-bg rounded overflow-hidden border border-transparent focus-within:border-accent">
      <div className="w-24 px-2 text-[10px] text-text-secondary font-semibold">{label}</div>
      <input type="number" className="flex-1 bg-transparent text-xs p-1 outline-none text-white text-right" value={value} onChange={(e) => onChange(parseFloat(e.target.value))} step={step} />
    </div>
  );
};

const DebouncedColorPicker: React.FC<{ value: string; onChange: (val: string) => void; label?: string; disabled?: boolean; }> = ({ value, onChange, label, disabled }) => {
    const [localValue, setLocalValue] = useState(value);
    const timeoutRef = useRef<number | null>(null);
    useEffect(() => { setLocalValue(value); }, [value]);
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVal = e.target.value; setLocalValue(newVal);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => { onChange(newVal); }, 100);
    };
    return <input type="color" value={localValue} onChange={handleChange} disabled={disabled} className={`w-full h-8 rounded bg-transparent cursor-pointer border border-white/10 ${disabled?'opacity-30 pointer-events-none':''}`} aria-label={label} />;
};

const ComponentCard: React.FC<{ 
  component: any; 
  title: string; 
  icon: string; 
  onRemove?: () => void;
  children: React.ReactNode;
}> = ({ component, title, icon, onRemove, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-panel-header border-b border-black/20">
      <div className="flex items-center p-2 cursor-pointer hover:bg-white/5 select-none group" onClick={() => setOpen(!open)}>
        <div className="mr-2 text-text-secondary group-hover:text-white transition-colors"><Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} /></div>
        <Icon name={icon as any} size={14} className="mr-2 text-accent" />
        <span className="font-semibold text-xs text-gray-200 flex-1">{title}</span>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
            {onRemove && <button className="p-1 hover:text-white text-text-secondary" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="Trash2" size={12} /></button>}
        </div>
      </div>
      {open && <div className="p-3 bg-panel border-t border-black/10 text-xs">{children}</div>}
    </div>
  );
};

export const InspectorPanel: React.FC<InspectorPanelProps> = ({ object: initialObject, selectionCount = 0, type: initialType = 'ENTITY', isClone = false }) => {
  const [isLocked, setIsLocked] = useState(isClone);
  const [snapshot, setSnapshot] = useState<{ object: any, type: any } | null>(null);
  const [name, setName] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [showAddComponent, setShowAddComponent] = useState(false);
  const editorCtx = useContext(EditorContext)!;
  const wm = useContext(WindowManagerContext);

  const activeObject = isLocked ? (snapshot?.object ?? initialObject) : initialObject;
  const activeType = isLocked ? (snapshot?.type ?? initialType) : initialType;

  useEffect(() => {
    if (!isLocked) {
        setSnapshot(prev => {
            if (prev?.object === initialObject && prev?.type === initialType) return prev;
            return { object: initialObject, type: initialType };
        });
    }
  }, [initialObject, initialType, isLocked]);

  useEffect(() => { if (activeObject && activeType === 'ENTITY') setName(activeObject.name); }, [activeObject, activeType]);

  const toggleLock = (e: React.MouseEvent) => {
    e.stopPropagation(); setIsLocked(!isLocked);
    if (!isLocked) setSnapshot({ object: initialObject, type: initialType });
  };

  const updateComponent = (compType: string, field: string, value: any) => {
      if (activeType !== 'ENTITY' || !activeObject) return;
      const entity = activeObject as Entity;
      const comp = entity.components[compType];
      if (comp) { (comp as any)[field] = value; engineInstance.notifyUI(); }
  };
  
  const addComponent = (compType: string) => {
      if (activeType !== 'ENTITY' || !activeObject) return;
      engineInstance.pushUndoState();
      engineInstance.ecs.addComponent((activeObject as Entity).id, compType as ComponentType);
      engineInstance.notifyUI();
      setShowAddComponent(false);
  };

  const removeComponent = (compType: string) => {
      if (activeType !== 'ENTITY' || !activeObject) return;
      engineInstance.pushUndoState();
      engineInstance.ecs.removeComponent((activeObject as Entity).id, compType as ComponentType);
      engineInstance.notifyUI();
  };

  if (!activeObject) {
    return (
        <div className="h-full bg-panel flex flex-col items-center justify-center text-text-secondary select-none">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4"><Icon name="BoxSelect" size={32} className="opacity-50" /></div>
            <span className="text-xs font-semibold">{selectionCount > 1 ? `${selectionCount} Objects Selected` : 'No Selection'}</span>
        </div>
    );
  }

  const renderHeaderControls = () => (
    <div className="flex items-center gap-1.5 ml-auto">
        <button onClick={toggleLock} className={`p-1 rounded transition-colors ${isLocked ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-white'}`}><Icon name={isLocked ? "Lock" : "Unlock"} size={13} /></button>
    </div>
  );

  // --- ENTITY INSPECTOR (DYNAMIC MODULES) ---
  if (activeType === 'ENTITY') {
      const entity = activeObject as Entity;
      const modules = moduleManager.getAllModules();
      
      const availableModules = modules.filter(m => !entity.components[m.id]);

      return (
        <div className="h-full bg-panel flex flex-col font-sans border-l border-black/20" onClick={() => setShowAddComponent(false)}>
          <div className="p-4 border-b border-black/20 bg-panel-header">
             <div className="flex items-center gap-3 mb-3">
                 <div className="w-8 h-8 bg-blue-500 rounded flex items-center justify-center text-white shadow-sm shrink-0"><Icon name="Box" size={16} /></div>
                 <div className="flex-1 min-w-0">
                     <input type="text" value={name} onChange={e => setName(e.target.value)} onBlur={() => { if(activeObject.name!==name) { engineInstance.pushUndoState(); activeObject.name = name; engineInstance.notifyUI(); } }} className="w-full bg-transparent text-sm font-bold text-white outline-none border-b border-transparent focus:border-accent transition-colors truncate" />
                     <div className="text-[10px] text-text-secondary font-mono mt-0.5 truncate select-all opacity-50">{entity.id}</div>
                 </div>
                 <input type="checkbox" checked={entity.isActive} onChange={(e) => { engineInstance.pushUndoState(); entity.isActive = e.target.checked; engineInstance.notifyUI(); }} className="cursor-pointer" title="Active" />
                 {renderHeaderControls()}
             </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
              {modules.map(mod => {
                  const comp = entity.components[mod.id];
                  if (!comp) return null;
                  return (
                      <ComponentCard 
                          key={mod.id} 
                          title={mod.name} 
                          icon={mod.icon} 
                          component={comp} 
                          onRemove={mod.id === 'Transform' ? undefined : () => removeComponent(mod.id)}
                      >
                          <mod.InspectorComponent 
                              entity={entity}
                              component={comp}
                              onUpdate={(f, v) => updateComponent(mod.id, f, v)}
                              onStartUpdate={() => engineInstance.pushUndoState()}
                              onCommit={() => engineInstance.notifyUI()}
                          />
                      </ComponentCard>
                  );
              })}

               <div className="p-4 flex justify-center pb-8 relative">
                <button className="bg-accent/20 hover:bg-accent/40 text-accent border border-accent/50 text-xs px-6 py-2 rounded-full font-semibold transition-all" onClick={(e) => { e.stopPropagation(); setShowAddComponent(!showAddComponent); }}>Add Component</button>
                {showAddComponent && (
                    <div className="absolute top-12 w-48 bg-[#252525] border border-white/10 shadow-xl rounded-md z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100">
                        {availableModules.length > 0 ? (
                            availableModules.map(m => (
                                <button key={m.id} className="w-full text-left px-3 py-2 text-xs hover:bg-accent hover:text-white flex items-center gap-2 text-gray-300" onClick={() => addComponent(m.id)}>
                                    <Icon name={m.icon as any} size={12} /> {m.name}
                                </button>
                            ))
                        ) : <div className="px-3 py-2 text-xs text-text-secondary italic">No components available</div>}
                    </div>
                )}
             </div>
          </div>
        </div>
      );
  }

  // --- SUB-COMPONENT INSPECTOR ---
  if (['VERTEX', 'EDGE', 'FACE'].includes(activeType as string)) {
      const subSel = engineInstance.subSelection;
      let count = 0;
      let label = '';
      if (activeType === 'VERTEX') { count = subSel.vertexIds.size; label = 'Vertices'; }
      if (activeType === 'EDGE') { count = subSel.edgeIds.size; label = 'Edges'; }
      if (activeType === 'FACE') { count = subSel.faceIds.size; label = 'Faces'; }

      return (
        <div className="h-full bg-panel flex flex-col font-sans border-l border-black/20">
            <div className="p-4 border-b border-black/20 bg-panel-header flex items-center gap-3">
                 <div className="w-8 h-8 bg-orange-500 rounded flex items-center justify-center text-white"><Icon name="Target" size={16} /></div>
                 <div className="flex-1 min-w-0 font-bold">{label} Selection</div>
                 {renderHeaderControls()}
            </div>
            <div className="p-4 space-y-4 text-xs">
                <div className="bg-black/20 p-3 rounded border border-white/5">
                    <div className="text-2xl font-mono text-white mb-1">{count}</div>
                    <div className="text-text-secondary uppercase text-[10px] font-bold">{label} Selected</div>
                </div>
                {/* Placeholder for tools like Weld, Split, Extrude */}
                <div className="grid grid-cols-2 gap-2">
                    <button className="bg-white/5 hover:bg-white/10 p-2 rounded text-center border border-white/5 transition-colors">Extrude</button>
                    <button className="bg-white/5 hover:bg-white/10 p-2 rounded text-center border border-white/5 transition-colors">Bevel</button>
                    <button className="bg-white/5 hover:bg-white/10 p-2 rounded text-center border border-white/5 transition-colors">Weld</button>
                    <button className="bg-white/5 hover:bg-white/10 p-2 rounded text-center border border-white/5 transition-colors">Split</button>
                </div>
            </div>
        </div>
      );
  }

  // --- ASSET & NODE INSPECTORS (Keep simplified for this refactor) ---
  if (activeType === 'ASSET') {
      const asset = activeObject as Asset;
      return (
        <div className="h-full bg-panel flex flex-col font-sans border-l border-black/20">
            <div className="p-4 border-b border-black/20 bg-panel-header flex items-center gap-3">
                 <div className="w-8 h-8 bg-green-600 rounded flex items-center justify-center text-white"><Icon name="File" size={16} /></div>
                 <div className="flex-1 min-w-0 font-bold">{asset.name}</div>
                 {renderHeaderControls()}
            </div>
            <div className="p-4 space-y-4">
                {asset.type === 'PHYSICS_MATERIAL' && (
                    <>
                        <DraggableNumber label="Static Friction" value={(asset as any).data.staticFriction} onChange={v => { assetManager.updatePhysicsMaterial(asset.id, {staticFriction:v}); setRefresh(r=>r+1); }} step={0.05} />
                        <DraggableNumber label="Dynamic Friction" value={(asset as any).data.dynamicFriction} onChange={v => { assetManager.updatePhysicsMaterial(asset.id, {dynamicFriction:v}); setRefresh(r=>r+1); }} step={0.05} />
                        <DraggableNumber label="Bounciness" value={(asset as any).data.bounciness} onChange={v => { assetManager.updatePhysicsMaterial(asset.id, {bounciness:v}); setRefresh(r=>r+1); }} step={0.05} />
                    </>
                )}
            </div>
        </div>
      );
  }

  // Fallback for nodes
  return <div className="p-4">Node Inspector</div>;
};
