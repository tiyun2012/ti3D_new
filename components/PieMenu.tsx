
import React, { useEffect, useState, useRef } from 'react';
import { Icon } from './Icon';
import { MeshComponentMode } from '../types';

interface PieMenuProps {
    x: number;
    y: number;
    onSelectMode: (mode: MeshComponentMode) => void;
    onAction: (action: string) => void;
    onClose: () => void;
    currentMode: MeshComponentMode;
    entityId?: string;
}

// Root Nodes (The 4 main circles)
const ROOT_NODES = [
    { id: 'SELECTION', icon: 'MousePointer2', angle: 270, label: 'Select Mode' }, // Top
    { id: 'ACTIONS', icon: 'Menu', angle: 0, label: 'Actions' },          // Right
    { id: 'P3', icon: 'Circle', angle: 90, label: 'Empty' },              // Bottom
    { id: 'P4', icon: 'Circle', angle: 180, label: 'Empty' }              // Left
];

// Sub Branches configuration
const BRANCHES: Record<string, any[]> = {
    'SELECTION': [
        { id: 'VERTEX', icon: 'Dot', label: 'Vertex', type: 'MODE' },
        { id: 'EDGE', icon: 'Minus', label: 'Edge', type: 'MODE' },
        { id: 'FACE', icon: 'Square', label: 'Face', type: 'MODE' },
        { id: 'OBJECT', icon: 'Box', label: 'Object', type: 'MODE' }
    ],
    'ACTIONS': [
        { id: 'focus', icon: 'Scan', label: 'Focus', type: 'ACTION' },
        { id: 'delete', icon: 'Trash2', label: 'Delete', color: '#ef4444', type: 'ACTION' },
        { id: 'duplicate', icon: 'Copy', label: 'Duplicate', type: 'ACTION' }
    ]
};

export const PieMenu: React.FC<PieMenuProps> = ({ x, y, onSelectMode, onAction, onClose, currentMode }) => {
    const [activeBranch, setActiveBranch] = useState<string | null>(null);
    const [hoverItem, setHoverItem] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    
    // To handle "sticky" sectors, we track the last valid branch in a ref
    // This allows us to lock the branch when the mouse moves outside the center hub
    const activeBranchRef = useRef<string | null>(null);
    
    // Radii configuration
    const R1 = 40; // Distance to root nodes
    const R2 = 85; // Distance to branch nodes
    const NODE_R = 16; // Radius of the node circles
    const SPREAD = 80; // Degrees spread for sub-items (Fit within 90deg sector)
    const LOCK_RADIUS = 25; // Radius beyond which the sector is locked

    useEffect(() => {
        const handleGlobalClick = () => onClose();
        
        const handleMouseMove = (e: MouseEvent) => {
            if (!menuRef.current) return;
            const rect = menuRef.current.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            // Normalize angle (0-360, 0 is Right)
            let angle = Math.atan2(dy, dx) * (180 / Math.PI);
            if (angle < 0) angle += 360;

            // 1. Determine which Root Sector we are in based on Angle
            let angleBranch = null;
            // 4 sectors of 90 degrees, offset by 45
            if (angle >= 315 || angle < 45) angleBranch = 'ACTIONS';
            else if (angle >= 225 && angle < 315) angleBranch = 'SELECTION';
            // We ignore Bottom and Left for now as they are placeholders
            
            // 2. Logic for Sticky/Locked Branch
            let effectiveBranch = activeBranchRef.current;

            if (dist < 10) {
                // Deadzone center - Reset everything
                effectiveBranch = null;
            } else if (dist < LOCK_RADIUS) {
                // Inside Hub - Free switching based on angle
                effectiveBranch = angleBranch;
            } else {
                // Outside Hub - Locked to previous branch
                // If we somehow jumped here without a branch, fallback to angle
                if (!effectiveBranch) effectiveBranch = angleBranch;
            }

            // Sync State and Ref
            if (activeBranchRef.current !== effectiveBranch) {
                activeBranchRef.current = effectiveBranch;
                setActiveBranch(effectiveBranch);
            }

            // 3. Check for item hover using Euclidean Distance
            // CRITICAL: Only check children of the EFFECTIVE locked branch
            let itemHit = null;

            if (effectiveBranch && BRANCHES[effectiveBranch]) {
                const subItems = BRANCHES[effectiveBranch];
                const rootNode = ROOT_NODES.find(n => n.id === effectiveBranch);
                const rootAngle = rootNode?.angle || 0;
                
                const startAngle = rootAngle - SPREAD / 2;
                const step = SPREAD / (subItems.length - 1 || 1);

                for (let i = 0; i < subItems.length; i++) {
                    const itemAngle = startAngle + (i * step);
                    const rad = itemAngle * (Math.PI / 180);
                    
                    // Calculate expected position of this item
                    const ix = Math.cos(rad) * R2;
                    const iy = Math.sin(rad) * R2;
                    
                    // Distance from mouse to item center
                    const distToItem = Math.sqrt((dx - ix) ** 2 + (dy - iy) ** 2);
                    
                    // Hit radius slightly larger than visual radius (20 vs 14-18)
                    if (distToItem < 22) {
                        itemHit = subItems[i].id;
                        break;
                    }
                }
            }

            // 4. Fallback to Root Node detection (only if in valid distance range)
            if (!itemHit && dist < (R1 + R2) / 2 && dist > 15) {
                if (effectiveBranch) itemHit = effectiveBranch; 
            } 

            setHoverItem(itemHit);
        };

        const handleMouseUp = () => {
             if (hoverItem) {
                 // Check if it is a sub-item action/mode
                 let found = false;
                 
                 // Check SELECTION items
                 if (BRANCHES['SELECTION']) {
                     const selItem = BRANCHES['SELECTION'].find(i => i.id === hoverItem);
                     if (selItem) {
                         onSelectMode(selItem.id as MeshComponentMode);
                         found = true;
                     }
                 }
                 
                 // Check ACTIONS items
                 if (!found && BRANCHES['ACTIONS']) {
                     const actItem = BRANCHES['ACTIONS'].find(i => i.id === hoverItem);
                     if (actItem) {
                         onAction(actItem.id);
                         found = true;
                     }
                 }
                 
                 if (found) onClose();
             }
        };
        
        // Delay global click to prevent immediate close if spawned by click
        const t = setTimeout(() => window.addEventListener('click', handleGlobalClick), 50);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        const preventContext = (e: Event) => e.preventDefault();
        window.addEventListener('contextmenu', preventContext);

        return () => {
            clearTimeout(t);
            window.removeEventListener('click', handleGlobalClick);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('contextmenu', preventContext);
        };
    }, [onClose, onSelectMode, onAction]);

    // Helper to get coords
    const getPos = (deg: number, r: number) => {
        const rad = deg * (Math.PI / 180);
        return { x: Math.cos(rad) * r, y: Math.sin(rad) * r };
    };

    return (
        <div 
            ref={menuRef}
            className="fixed z-[9999] select-none pointer-events-none" 
            style={{ left: x - 150, top: y - 150, width: 300, height: 300 }}
        >
            <svg className="absolute inset-0 w-full h-full overflow-visible">
                <g transform="translate(150, 150)">
                    
                    {/* --- ROOT LEVEL --- */}
                    {ROOT_NODES.map(node => {
                        const pos = getPos(node.angle, R1);
                        const isBranchActive = activeBranch === node.id;
                        const isHovered = hoverItem === node.id;
                        const isPlaceholder = node.id.startsWith('P');
                        
                        return (
                            <g key={node.id} className="transition-all duration-200">
                                {/* Connector Line */}
                                <line 
                                    x1={0} y1={0} x2={pos.x} y2={pos.y}
                                    stroke={isBranchActive ? '#4f80f8' : (isPlaceholder ? '#333' : '#555')}
                                    strokeWidth={1}
                                    className="transition-colors duration-200"
                                />
                                
                                {/* Node Circle (Hollow) */}
                                <circle 
                                    cx={pos.x} cy={pos.y} r={NODE_R}
                                    fill="#101010"
                                    fillOpacity={0.9}
                                    stroke={isBranchActive ? '#4f80f8' : (isPlaceholder ? '#333' : '#666')}
                                    strokeWidth={isBranchActive || isHovered ? 2 : 1}
                                    className="transition-all duration-200"
                                />

                                {/* Icon */}
                                <foreignObject 
                                    x={pos.x - 8} y={pos.y - 8} width="16" height="16"
                                    className="pointer-events-none"
                                >
                                    <div className={`flex items-center justify-center w-full h-full ${isBranchActive ? 'text-accent' : 'text-gray-400'}`}>
                                        <Icon name={node.icon as any} size={16} />
                                    </div>
                                </foreignObject>
                                
                                {/* Label (If Hovered Root) */}
                                {isHovered && !isPlaceholder && (
                                    <text 
                                        x={pos.x} y={pos.y + 30} 
                                        textAnchor="middle" fill="white" fontSize="10" fontWeight="bold"
                                        className="drop-shadow-md"
                                    >
                                        {node.label}
                                    </text>
                                )}
                            </g>
                        );
                    })}

                    {/* --- BRANCH LEVEL --- */}
                    {activeBranch && BRANCHES[activeBranch] && BRANCHES[activeBranch].map((item, i) => {
                        const rootAngle = ROOT_NODES.find(n => n.id === activeBranch)?.angle || 0;
                        const count = BRANCHES[activeBranch].length;
                        const spread = SPREAD; 
                        const startAngle = rootAngle - spread / 2;
                        const step = spread / (count - 1 || 1);
                        const angle = startAngle + (i * step);
                        
                        const pos = getPos(angle, R2);
                        const rootPos = getPos(rootAngle, R1);
                        
                        const isHovered = hoverItem === item.id;
                        const isActiveMode = currentMode === item.id;
                        const isRelevant = isHovered || isActiveMode;
                        
                        return (
                            <g key={item.id} className="animate-in fade-in zoom-in-90 duration-150">
                                {/* Connector from Root to Branch Node */}
                                <path 
                                    d={`M ${rootPos.x} ${rootPos.y} Q ${rootPos.x * 1.2} ${rootPos.y * 1.2} ${pos.x} ${pos.y}`}
                                    fill="none"
                                    stroke={isRelevant ? '#4f80f8' : '#444'}
                                    strokeWidth={1}
                                    strokeDasharray={isRelevant ? "0" : "2,2"}
                                />

                                {/* Sub Node Circle */}
                                <circle 
                                    cx={pos.x} cy={pos.y} r={isHovered ? 18 : 14}
                                    fill="#101010"
                                    stroke={isRelevant ? (item.color || '#4f80f8') : '#555'}
                                    strokeWidth={isRelevant ? 2 : 1}
                                    className="transition-all duration-150"
                                />

                                {/* Icon */}
                                <foreignObject 
                                    x={pos.x - 8} y={pos.y - 8} width="16" height="16"
                                    className="pointer-events-none"
                                >
                                    <div className={`flex items-center justify-center w-full h-full ${isRelevant ? (item.color ? '' : 'text-white') : 'text-gray-500'}`} style={{ color: (isRelevant && item.color) ? item.color : undefined }}>
                                        <Icon name={item.icon as any} size={14} />
                                    </div>
                                </foreignObject>

                                {/* Label on Hover or Active */}
                                {(isHovered || isActiveMode) && (
                                    <g>
                                        <rect 
                                            x={pos.x - 30} y={pos.y + 20} width="60" height="16" rx="4"
                                            fill="black" fillOpacity="0.8"
                                        />
                                        <text 
                                            x={pos.x} y={pos.y + 31} 
                                            textAnchor="middle" fill={item.color || "white"} fontSize="9" fontWeight="bold"
                                        >
                                            {item.label}
                                        </text>
                                    </g>
                                )}
                            </g>
                        );
                    })}

                    {/* Center Dot (Pivot) */}
                    <circle cx="0" cy="0" r="3" fill="white" className="drop-shadow-lg" />
                    <circle cx="0" cy="0" r="8" fill="none" stroke="white" strokeOpacity="0.3" />
                </g>
            </svg>
        </div>
    );
};
