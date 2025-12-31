
import React, { useContext, useState, useEffect } from 'react';
import { EditorContext } from '../contexts/EditorContext';
import { Icon } from './Icon';
import { engineInstance } from '../services/engine';
import { assetManager } from '../services/AssetManager';
import { SkeletalMeshAsset } from '../types';

export const SkinningEditor: React.FC = () => {
    const { selectedAssetIds, selectedIds } = useContext(EditorContext)!;
    const [bones, setBones] = useState<{name: string, index: number}[]>([]);
    const [selectedBones, setSelectedBones] = useState<Set<number>>(new Set());
    const [weight, setWeight] = useState(0.5);
    const [mode, setMode] = useState<'ADD' | 'REPLACE' | 'SMOOTH' | 'REMOVE'>('ADD');
    const [asset, setAsset] = useState<SkeletalMeshAsset | null>(null);
    const [search, setSearch] = useState('');

    useEffect(() => {
        let foundAsset: SkeletalMeshAsset | null = null;
        
        if (selectedIds.length > 0) {
            const idx = engineInstance.ecs.idToIndex.get(selectedIds[0]);
            if (idx !== undefined) {
                const meshIntId = engineInstance.ecs.store.meshType[idx];
                const uuid = assetManager.meshIntToUuid.get(meshIntId);
                if (uuid) {
                    const a = assetManager.getAsset(uuid);
                    if (a && a.type === 'SKELETAL_MESH') foundAsset = a as SkeletalMeshAsset;
                }
            }
        }
        
        if (selectedAssetIds.length > 0) {
            const a = assetManager.getAsset(selectedAssetIds[0]);
            if (a && a.type === 'SKELETAL_MESH') foundAsset = a as SkeletalMeshAsset;
        }

        if (foundAsset) {
            setAsset(foundAsset);
            setBones(foundAsset.skeleton.bones.map((b, i) => ({ name: b.name, index: i })));
        } else {
            setAsset(null);
            setBones([]);
        }
    }, [selectedIds, selectedAssetIds]);

    const handlePaint = () => {
        if (!asset || selectedBones.size === 0) return;
        const boneList = Array.from(selectedBones).join(', ');
        alert(`Painting Weight ${weight} on Bones [${boneList}] using ${mode} mode (Mock)`);
    };

    const toggleBone = (idx: number, multi: boolean) => {
        if (multi) {
            const next = new Set(selectedBones);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            setSelectedBones(next);
        } else {
            setSelectedBones(new Set([idx]));
        }
    };

    const filteredBones = bones.filter(b => b.name.toLowerCase().includes(search.toLowerCase()));

    if (!asset) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-text-secondary select-none">
                <Icon name="PersonStanding" size={48} className="opacity-30 mb-2" strokeWidth={1} />
                <span className="text-xs">Select a Skeletal Mesh</span>
                <span className="text-[10px] opacity-60">to edit skin weights</span>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-[#1a1a1a] text-xs font-sans">
            <div className="bg-panel-header px-3 py-2 border-b border-white/10 font-bold flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Icon name="Edit3" size={14} className="text-accent" />
                    Skinning Tools
                </div>
                <div className="text-[10px] text-text-secondary">Maya Style</div>
            </div>
            
            {/* Paint Operations */}
            <div className="p-3 border-b border-white/5 space-y-3 bg-black/20">
                <div className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Paint Operation</div>
                <div className="grid grid-cols-2 gap-2">
                    {['ADD', 'REPLACE', 'SMOOTH', 'REMOVE'].map(m => (
                        <button 
                            key={m}
                            onClick={() => setMode(m as any)} 
                            className={`py-1.5 rounded border text-center transition-colors text-[10px] uppercase font-bold
                                ${mode === m ? 'bg-accent border-accent text-white' : 'border-white/10 text-text-secondary hover:text-white bg-white/5'}
                            `}
                        >
                            {m}
                        </button>
                    ))}
                </div>
                
                <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                        <span className="text-text-secondary">Value</span>
                        <span className="font-mono bg-black/40 px-1.5 rounded text-white">{weight.toFixed(2)}</span>
                    </div>
                    <input 
                        type="range" 
                        min="0" max="1" step="0.01" 
                        value={weight} 
                        onChange={e => setWeight(parseFloat(e.target.value))} 
                        className="w-full accent-accent h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer" 
                    />
                </div>
                
                <div className="flex gap-2 pt-1">
                    <button className="flex-1 bg-white/5 hover:bg-white/10 py-1.5 rounded border border-white/10 text-text-secondary hover:text-white transition-colors">
                        Flood
                    </button>
                    <button className="flex-1 bg-white/5 hover:bg-white/10 py-1.5 rounded border border-white/10 text-text-secondary hover:text-white transition-colors">
                        Prune Small
                    </button>
                </div>
            </div>

            {/* Bone List */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="px-3 py-2 bg-black/10 border-b border-white/5 flex items-center gap-2">
                    <Icon name="Search" size={12} className="text-text-secondary" />
                    <input 
                        type="text" 
                        placeholder="Search Influences..." 
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="bg-transparent text-xs text-white outline-none w-full placeholder:text-text-secondary"
                    />
                </div>
                
                <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
                    {filteredBones.map(bone => {
                        const isSelected = selectedBones.has(bone.index);
                        return (
                            <div 
                                key={bone.index}
                                onClick={(e) => toggleBone(bone.index, e.shiftKey || e.ctrlKey)}
                                className={`px-2 py-1.5 cursor-pointer flex items-center justify-between rounded mb-0.5 border border-transparent transition-all
                                    ${isSelected ? 'bg-accent/20 border-accent/30 text-white' : 'hover:bg-white/5 text-text-secondary hover:text-white'}
                                `}
                            >
                                <div className="flex items-center gap-2">
                                    <Icon name="Bone" size={12} className={isSelected ? 'text-accent' : 'opacity-50'} />
                                    <span>{bone.name}</span>
                                </div>
                                {isSelected && <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />}
                            </div>
                        );
                    })}
                    {filteredBones.length === 0 && (
                        <div className="text-center py-4 text-text-secondary opacity-50 italic">No bones found</div>
                    )}
                </div>
            </div>
            
            {/* Footer */}
            <div className="p-3 border-t border-white/10 bg-black/30">
                <button 
                    onClick={handlePaint} 
                    className="w-full bg-accent hover:bg-accent-hover py-2 rounded font-bold text-white shadow-lg transition-all flex items-center justify-center gap-2"
                >
                    <Icon name="Brush" size={14} /> Paint Weights
                </button>
            </div>
        </div>
    );
};
