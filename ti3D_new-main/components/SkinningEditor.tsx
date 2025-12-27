
import React, { useContext, useState, useEffect } from 'react';
import { EditorContext } from '../contexts/EditorContext';
import { Icon } from './Icon';
import { engineInstance } from '../services/engine';
import { assetManager } from '../services/AssetManager';
import { SkeletalMeshAsset } from '../types';

export const SkinningEditor: React.FC = () => {
    const { selectedAssetIds, selectedIds } = useContext(EditorContext)!;
    const [bones, setBones] = useState<{name: string, index: number}[]>([]);
    const [selectedBone, setSelectedBone] = useState<number>(-1);
    const [weight, setWeight] = useState(0.5);
    const [mode, setMode] = useState<'ADD' | 'REPLACE' | 'SMOOTH'>('ADD');
    const [asset, setAsset] = useState<SkeletalMeshAsset | null>(null);

    useEffect(() => {
        let foundAsset: SkeletalMeshAsset | null = null;
        
        // 1. Check selected Entity
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
        
        // 2. Check selected Asset (override)
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
        if (!asset || selectedBone === -1) return;
        // Mock paint logic: In a real app, this would use a brush system in the viewport
        alert(`Painting Weight ${weight} on Bone ${selectedBone} using ${mode} mode (Mock)`);
    };

    if (!asset) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-text-secondary">
                <Icon name="PersonStanding" size={32} className="opacity-50 mb-2" />
                <span className="text-xs">Select a Skeletal Mesh to edit skinning</span>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-[#1a1a1a] text-xs">
            <div className="bg-panel-header px-3 py-2 border-b border-white/10 font-bold flex items-center gap-2">
                <Icon name="Edit3" size={14} className="text-accent" />
                Skinning Editor
            </div>
            
            <div className="p-3 border-b border-white/5 space-y-3">
                <div className="flex gap-2">
                    <button onClick={() => setMode('ADD')} className={`flex-1 py-1 rounded border ${mode === 'ADD' ? 'bg-accent border-accent text-white' : 'border-white/10 text-text-secondary hover:text-white'}`}>Add</button>
                    <button onClick={() => setMode('REPLACE')} className={`flex-1 py-1 rounded border ${mode === 'REPLACE' ? 'bg-accent border-accent text-white' : 'border-white/10 text-text-secondary hover:text-white'}`}>Replace</button>
                    <button onClick={() => setMode('SMOOTH')} className={`flex-1 py-1 rounded border ${mode === 'SMOOTH' ? 'bg-accent border-accent text-white' : 'border-white/10 text-text-secondary hover:text-white'}`}>Smooth</button>
                </div>
                
                <div className="flex items-center gap-2">
                    <span className="w-12 text-text-secondary">Weight</span>
                    <input type="range" min="0" max="1" step="0.01" value={weight} onChange={e => setWeight(parseFloat(e.target.value))} className="flex-1" />
                    <span className="w-8 text-right font-mono">{weight.toFixed(2)}</span>
                </div>
                
                <button onClick={handlePaint} className="w-full bg-white/10 hover:bg-white/20 py-1 rounded text-white transition-colors">
                    Paint Selected (Mock)
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="px-3 py-2 text-[10px] text-text-secondary uppercase font-bold tracking-wider opacity-70">Bones</div>
                {bones.map(bone => (
                    <div 
                        key={bone.index}
                        onClick={() => setSelectedBone(bone.index)}
                        className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 hover:bg-white/5 ${selectedBone === bone.index ? 'bg-accent/20 text-white' : 'text-text-primary'}`}
                    >
                        <div className={`w-3 h-3 rounded-full border ${selectedBone === bone.index ? 'bg-accent border-accent' : 'border-white/30'}`}></div>
                        {bone.name}
                    </div>
                ))}
            </div>
        </div>
    );
};
