
import React, { useContext, useState, useEffect } from 'react';
import { EditorContext } from '../contexts/EditorContext';
import { Icon } from './Icon';
import { engineInstance } from '../services/engine';
import { assetManager } from '../services/AssetManager';
import { SkeletalMeshAsset } from '../types';
import { Vec3Utils, Mat4Utils, QuatUtils } from '../services/math';

export const SkinningEditor: React.FC = () => {
    const { selectedAssetIds, selectedIds, setMeshComponentMode } = useContext(EditorContext)!;
    const [bones, setBones] = useState<{name: string, index: number}[]>([]);
    const [selectedBone, setSelectedBone] = useState<number>(-1);
    const [weight, setWeight] = useState(0.5);
    const [mode, setMode] = useState<'ADD' | 'REPLACE' | 'SMOOTH'>('ADD');
    const [asset, setAsset] = useState<SkeletalMeshAsset | null>(null);
    const [poseRot, setPoseRot] = useState({ x: 0, y: 0, z: 0 });

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
            // Ensure visualization mode is active
            if (engineInstance.renderMode !== 5) engineInstance.setRenderMode(5);
        } else {
            setAsset(null);
            setBones([]);
            if (engineInstance.renderMode === 5) engineInstance.setRenderMode(0); // Reset to Lit
        }
    }, [selectedIds, selectedAssetIds]);

    // Handle Pose Update
    useEffect(() => {
        if (!asset || selectedBone === -1) return;
        
        // Create matrices for all bones
        // In a real system, we'd traverse hierarchy. Here we just set the selected bone relative to identity
        // to simplify visual testing.
        const boneData = new Float32Array(1024 * 4);
        
        // Fill identity first
        for(let i=0; i<256; i++) {
            const b = i*16;
            boneData[b] = 1; boneData[b+5] = 1; boneData[b+10] = 1; boneData[b+15] = 1;
        }

        // Apply Rotation to selected bone
        const q = QuatUtils.fromEuler(poseRot.x * Math.PI / 180, poseRot.y * Math.PI / 180, poseRot.z * Math.PI / 180, QuatUtils.create());
        const mat = Mat4Utils.create();
        Mat4Utils.compose({x:0, y:0, z:0}, q, {x:1, y:1, z:1}, mat);
        
        // Update specific bone slot
        const base = selectedBone * 16;
        for(let k=0; k<16; k++) boneData[base+k] = mat[k];

        // If child bones exist, they should inherit... but for simple weight painting test, 
        // moving just one bone is often enough to see vertices stretching.
        
        engineInstance.manualBoneData = boneData;
        
    }, [poseRot, selectedBone, asset]);

    const handleSelectBone = (index: number) => {
        setSelectedBone(index);
        engineInstance.renderer.selectedBoneIndex = index;
        setPoseRot({ x: 0, y: 0, z: 0 }); // Reset pose on switch
    };

    const handlePaint = () => {
        if (!asset || selectedBone === -1) return;
        
        const indices = engineInstance.selectedIndices;
        // Logic: Apply to selected vertices if any, else nothing (safety)
        if (engineInstance.subSelection.vertexIds.size === 0) {
            alert("Select vertices in scene first (Hold Shift + Click)");
            return;
        }

        const jIdx = asset.geometry.jointIndices;
        const jW = asset.geometry.jointWeights;
        const vertices = Array.from(engineInstance.subSelection.vertexIds);

        vertices.forEach(vIdx => {
            const base = vIdx * 4;
            let currentWeights = [jW[base], jW[base+1], jW[base+2], jW[base+3]];
            let currentIndices = [jIdx[base], jIdx[base+1], jIdx[base+2], jIdx[base+3]];

            // Find slot for selected bone
            let slot = -1;
            for(let i=0; i<4; i++) if (currentIndices[i] === selectedBone) slot = i;

            if (slot === -1) {
                // Find weakest slot to replace
                let minW = 2.0; 
                for(let i=0; i<4; i++) {
                    if (currentWeights[i] < minW) { minW = currentWeights[i]; slot = i; }
                }
                currentIndices[slot] = selectedBone;
                currentWeights[slot] = 0; // Prepare to add
            }

            // Apply Operation
            if (mode === 'REPLACE') {
                currentWeights[slot] = weight;
            } else if (mode === 'ADD') {
                currentWeights[slot] += weight;
            } else if (mode === 'SMOOTH') {
                // Mock smooth: average with 0.5
                currentWeights[slot] = (currentWeights[slot] + 0.5) / 2;
            }

            // Normalize
            let sum = 0;
            for(let i=0; i<4; i++) sum += currentWeights[i];
            if (sum > 0.0001) {
                for(let i=0; i<4; i++) currentWeights[i] /= sum;
            }

            // Write back
            for(let i=0; i<4; i++) {
                jW[base+i] = currentWeights[i];
                jIdx[base+i] = currentIndices[i];
            }
        });

        // Re-upload to GPU
        const internalId = assetManager.getMeshID(asset.id);
        engineInstance.renderer.registerMesh(internalId, asset.geometry);
        engineInstance.tick(0); // Force redraw
    };

    if (!asset) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-text-secondary select-none">
                <Icon name="PersonStanding" size={32} className="opacity-50 mb-2" />
                <span className="text-xs">Select a Skeletal Mesh</span>
                <span className="text-[10px] opacity-60">to edit skinning</span>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-[#1a1a1a] text-xs font-sans">
            <div className="bg-panel-header px-3 py-2 border-b border-white/10 font-bold flex items-center gap-2 text-white">
                <Icon name="Edit3" size={14} className="text-accent" />
                Skinning Editor
            </div>
            
            <div className="p-3 border-b border-white/5 space-y-3 bg-black/20">
                <div className="flex gap-2">
                    <button onClick={() => setMode('ADD')} className={`flex-1 py-1 rounded border transition-colors ${mode === 'ADD' ? 'bg-accent border-accent text-white font-bold' : 'border-white/10 text-text-secondary hover:text-white'}`}>Add</button>
                    <button onClick={() => setMode('REPLACE')} className={`flex-1 py-1 rounded border transition-colors ${mode === 'REPLACE' ? 'bg-accent border-accent text-white font-bold' : 'border-white/10 text-text-secondary hover:text-white'}`}>Replace</button>
                    <button onClick={() => setMode('SMOOTH')} className={`flex-1 py-1 rounded border transition-colors ${mode === 'SMOOTH' ? 'bg-accent border-accent text-white font-bold' : 'border-white/10 text-text-secondary hover:text-white'}`}>Smooth</button>
                </div>
                
                <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-text-secondary uppercase font-bold">
                        <span>Weight Strength</span>
                        <span>{weight.toFixed(2)}</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.01" value={weight} onChange={e => setWeight(parseFloat(e.target.value))} className="w-full accent-accent" />
                </div>
                
                <button onClick={handlePaint} className="w-full bg-emerald-600 hover:bg-emerald-500 py-1.5 rounded text-white font-bold transition-colors flex items-center justify-center gap-2">
                    <Icon name="Brush" size={14} /> Apply to Selected Verts
                </button>
                
                <div className="border-t border-white/10 my-2"></div>
                
                {/* Pose Test Section */}
                <div className="space-y-2">
                    <div className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Pose Test</div>
                    <div className="grid grid-cols-3 gap-1">
                        <div className="bg-black/30 rounded p-1 flex flex-col items-center">
                            <span className="text-[9px] text-red-400 font-bold mb-1">Rot X</span>
                            <input type="range" min="-90" max="90" value={poseRot.x} onChange={e => setPoseRot({...poseRot, x: parseFloat(e.target.value)})} className="w-full accent-red-500 h-1" />
                        </div>
                        <div className="bg-black/30 rounded p-1 flex flex-col items-center">
                            <span className="text-[9px] text-green-400 font-bold mb-1">Rot Y</span>
                            <input type="range" min="-90" max="90" value={poseRot.y} onChange={e => setPoseRot({...poseRot, y: parseFloat(e.target.value)})} className="w-full accent-green-500 h-1" />
                        </div>
                        <div className="bg-black/30 rounded p-1 flex flex-col items-center">
                            <span className="text-[9px] text-blue-400 font-bold mb-1">Rot Z</span>
                            <input type="range" min="-90" max="90" value={poseRot.z} onChange={e => setPoseRot({...poseRot, z: parseFloat(e.target.value)})} className="w-full accent-blue-500 h-1" />
                        </div>
                    </div>
                    <button onClick={() => setPoseRot({x:0, y:0, z:0})} className="w-full py-1 text-[9px] bg-white/5 hover:bg-white/10 rounded text-text-secondary">Reset Pose</button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="px-3 py-2 text-[10px] text-text-secondary uppercase font-bold tracking-wider opacity-70 sticky top-0 bg-[#1a1a1a]">Bones</div>
                {bones.map(bone => (
                    <div 
                        key={bone.index}
                        onClick={() => handleSelectBone(bone.index)}
                        className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 transition-colors border-l-2 ${selectedBone === bone.index ? 'bg-white/10 border-accent text-white' : 'border-transparent text-text-secondary hover:text-white hover:bg-white/5'}`}
                    >
                        <Icon name="Bone" size={12} className={selectedBone === bone.index ? "text-accent" : "opacity-50"} />
                        {bone.name}
                    </div>
                ))}
            </div>
        </div>
    );
};
