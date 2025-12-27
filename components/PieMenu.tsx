
import React, { useEffect, useState, useRef, useMemo } from 'react';
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
    
    // Radii configuration
    const R1 = 40; // Distance to root nodes
    const R2 = 85; // Distance to branch nodes
    const NODE_R = 16; // Radius of the node circles

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

            // 1. Determine which Root Sector we are in
            let branch = null;
            // 4 sectors of 90 degrees, offset by 45
            if (angle >= 315 || angle < 45) branch = 'ACTIONS';
            else if (angle >= 225 && angle < 315) branch = 'SELECTION';
            // We ignore Bottom and Left for now as they are placeholders
            
            if (dist < 10) {
                // Deadzone center
                setActiveBranch(null);
                setHoverItem(null);
                return;
            }

            setActiveBranch(branch);

            // 2. Check for item hover
            let itemHit = null;

            // Check Root Nodes collision
            // Note: simple angle check implies we are "aiming" at it
            if (dist < (R1 + R2) / 2) {
                // We are closer to root ring
                if (branch) itemHit = branch; // The root node ID matches the branch key
            } 
            // Check Branch Nodes collision
            else if (branch && BRANCHES[branch]) {
                const subItems = BRANCHES[branch];
                // Calculate angles for sub items
                const rootAngle = ROOT_NODES.find(n => n.id === branch)?.angle || 0;
                const totalSpread = 100; 
                const startAngle = rootAngle - totalSpread / 2;
                const step = totalSpread / (subItems.length - 1 || 1);

                let bestSubDist = 999;
                
                // Find closest sub-node based on angle difference
                subItems.forEach((item, idx) => {
                    let itemAngle = startAngle + (idx * step);
                    // Normalize itemAngle
                    if (itemAngle < 0) itemAngle += 360;
                    
                    let diff = Math.abs(angle - itemAngle);
                    if (diff > 180) diff = 360 - diff;
                    
                    if (diff < 15) { // 15 degree tolerance
                        itemHit = item.id;
                    }
                });
            }

            setHoverItem(itemHit);
        };

        const handleMouseUp = () => {
             if (hoverItem) {
                 // Check if it is a sub-item action/mode
                 let found = false;
                 
                 // Search in Selection Branch
                 const selItem = BRANCHES['SELECTION'].find(i => i.id === hoverItem);
                 if (selItem) {
                     onSelectMode(selItem.id as MeshComponentMode);
                     found = true;
                 }
                 
                 // Search in Actions Branch
                 const actItem = BRANCHES['ACTIONS'].find(i => i.id === hoverItem);
                 if (actItem) {
                     onAction(actItem.id);
                     found = true;
                 }
                 
                 if (found) onClose();
             }
        };
        
        setTimeout(() => window.addEventListener('click', handleGlobalClick), 10);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        const preventContext = (e: Event) => e.preventDefault();
        window.addEventListener('contextmenu', preventContext);

        return () => {
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
                        const spread = 100; // Total arc spread in degrees
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
