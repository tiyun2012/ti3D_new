
import React from 'react';

// ECS Types
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export type RotationOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';
export type TransformSpace = 'World' | 'Local' | 'Gimbal';
export type MeshComponentMode = 'OBJECT' | 'VERTEX' | 'EDGE' | 'FACE';

export enum ComponentType {
  TRANSFORM = 'Transform',
  MESH = 'Mesh',
  LIGHT = 'Light',
  PHYSICS = 'Physics',
  SCRIPT = 'Script',
  VIRTUAL_PIVOT = 'VirtualPivot'
}

// --- MODULAR SYSTEM TYPES ---

export interface ModuleContext {
    engine: any; // Reference to Engine instance
    ecs: any;    // Reference to ECS
    scene: any;  // Reference to SceneGraph
}

export interface InspectorProps {
    entity: Entity;
    component: Component;
    onUpdate: (field: string, value: any) => void;
    onStartUpdate: () => void;
    onCommit: () => void;
}

export interface EngineModule {
    id: ComponentType | string;
    name: string;
    icon: string;
    order: number; // For UI sorting
    
    // UI Rendering
    InspectorComponent: React.FC<InspectorProps>;
    
    // Lifecycle
    onRegister?: (ctx: ModuleContext) => void;
    onUpdate?: (dt: number, ctx: ModuleContext) => void;
    onRender?: (gl: WebGL2RenderingContext, viewProj: Float32Array, ctx: ModuleContext) => void;
}

// ----------------------------

export interface Component {
  type: ComponentType | string;
  [key: string]: any;
}

export interface Entity {
  id: string;
  name: string;
  components: Record<string, Component>;
  isActive: boolean;
}

// Timeline Types
export interface TimelineState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackSpeed: number;
  isLooping: boolean;
}

// Node Graph Types
export interface GraphNode {
  id: string;
  type: string; // Must match key in NodeRegistry
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data?: any; // Internal node state (e.g. constant values)
}

export interface GraphConnection {
  id: string;
  fromNode: string;
  fromPin: string;
  toNode: string;
  toPin: string;
}

// Editor Types
export type EditorMode = 'SCENE' | 'GAME' | 'SCRIPT';
export type ToolType = 'SELECT' | 'MOVE' | 'ROTATE' | 'SCALE';
export type SelectionType = 'ENTITY' | 'ASSET';

export interface PerformanceMetrics {
  fps: number;
  frameTime: number;
  drawCalls: number;
  triangleCount: number;
  entityCount: number;
}

// Mesh Topology Types
export interface LogicalMesh {
    // Defines the original Faces (Quads/Polygons)
    faces: number[][]; 
    
    // Map: Which Render Triangle belongs to which Logical Face?
    triangleToFaceIndex: Int32Array;

    // Connectivity maps for fast lookups
    vertexToFaces: Map<number, number[]>;
}

// Asset Types
export type AssetType = 'MESH' | 'SKELETAL_MESH' | 'MATERIAL' | 'PHYSICS_MATERIAL' | 'TEXTURE' | 'SCRIPT' | 'RIG';

export interface StaticMeshAsset {
    id: string;
    name: string;
    type: 'MESH';
    thumbnail?: string; 
    isProtected?: boolean;
    geometry: {
        vertices: Float32Array;
        normals: Float32Array;
        uvs: Float32Array;
        indices: Uint16Array;
    };
    topology?: LogicalMesh; // Optional CPU-side topology data
}

export interface SkeletalMeshAsset {
    id: string;
    name: string;
    type: 'SKELETAL_MESH';
    thumbnail?: string;
    isProtected?: boolean;
    geometry: {
        vertices: Float32Array;
        normals: Float32Array;
        uvs: Float32Array;
        indices: Uint16Array;
        jointIndices: Float32Array;
        jointWeights: Float32Array;
    };
    skeleton: {
        bones: Array<{ name: string; parentIndex: number; bindPose: Float32Array }>;
    };
    topology?: LogicalMesh;
}

export interface MaterialAsset {
    id: string;
    name: string;
    type: 'MATERIAL';
    isProtected?: boolean;
    data: {
        nodes: GraphNode[];
        connections: GraphConnection[];
        glsl: string; 
    };
}

export interface PhysicsMaterialAsset {
    id: string;
    name: string;
    type: 'PHYSICS_MATERIAL';
    isProtected?: boolean;
    data: {
        staticFriction: number;
        dynamicFriction: number;
        bounciness: number; 
        density: number;
    };
}

export interface ScriptAsset {
    id: string;
    name: string;
    type: 'SCRIPT';
    isProtected?: boolean;
    data: {
        nodes: GraphNode[];
        connections: GraphConnection[];
    };
}

export interface RigAsset {
    id: string;
    name: string;
    type: 'RIG';
    isProtected?: boolean;
    data: {
        nodes: GraphNode[];
        connections: GraphConnection[];
    };
}

export interface TextureAsset {
    id: string;
    name: string;
    type: 'TEXTURE';
    isProtected?: boolean;
    source: string; 
    layerIndex: number; 
}

export type Asset = StaticMeshAsset | SkeletalMeshAsset | MaterialAsset | PhysicsMaterialAsset | ScriptAsset | RigAsset | TextureAsset;
