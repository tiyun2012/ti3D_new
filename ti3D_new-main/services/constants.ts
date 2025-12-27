
export const INITIAL_CAPACITY = 10000;
export const MESH_TYPES: Record<string, number> = { 'None': 0, 'Cube': 1, 'Sphere': 2, 'Plane': 3, 'Cylinder': 4, 'Cone': 5 };
export const MESH_NAMES: Record<number, string> = { 0: 'None', 1: 'Cube', 2: 'Sphere', 3: 'Plane', 4: 'Cylinder', 5: 'Cone' };

export const ROTATION_ORDERS: string[] = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
export const ROTATION_ORDER_MAP: Record<string, number> = { 
    'XYZ': 0, 'XZY': 1, 'YXZ': 2, 'YZX': 3, 'ZXY': 4, 'ZYX': 5 
};
export const ROTATION_ORDER_ZY_MAP: Record<number, string> = { 
    0: 'XYZ', 1: 'XZY', 2: 'YXZ', 3: 'YZX', 4: 'ZXY', 5: 'ZYX' 
};

export const LIGHT_TYPES: string[] = ['Directional', 'Point', 'Spot'];
export const LIGHT_TYPE_MAP: Record<string, number> = { 'Directional': 0, 'Point': 1, 'Spot': 2 };
export const LIGHT_TYPE_NAMES: Record<number, string> = { 0: 'Directional', 1: 'Point', 2: 'Spot' };

export const COMPONENT_MASKS = {
    TRANSFORM: 1,
    MESH: 2,
    LIGHT: 4,
    PHYSICS: 8,
    SCRIPT: 16,
    VIRTUAL_PIVOT: 32 
};

export const VIEW_MODES = [
    { id: 0, label: 'Lit', icon: 'Sun' },
    { id: 1, label: 'Normals', icon: 'BoxSelect' },
    { id: 2, label: 'Unlit', icon: 'Circle' },
    { id: 3, label: 'Wireframe', icon: 'Grid' },
    { id: 4, label: 'Overdraw', icon: 'Layers' }
];
