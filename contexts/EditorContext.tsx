
import React from 'react';
import { Entity, ToolType, TransformSpace, SelectionType, GraphNode, GraphConnection, MeshComponentMode } from '../types';
import { SceneGraph } from '../services/SceneGraph';

export type VertexShape = 'DOT' | 'CUBE';

export interface UIConfiguration {
    windowBorderRadius: number;
    resizeHandleThickness: number;
    resizeHandleColor: string;
    resizeHandleOpacity: number;
    resizeHandleLength: number;
    // New Visual Preferences
    selectionEdgeHighlight: boolean;
    selectionEdgeColor: string;
    vertexSize: number;
    vertexColor: string;
    vertexShape: VertexShape;
}

export interface GridConfiguration {
    visible: boolean;
    size: number;            // Spacing of main lines (meters)
    subdivisions: number;    // Number of cells inside a main line
    opacity: number;         // Base alpha
    fadeDistance: number;
    color: string;
    excludeFromPostProcess: boolean;
}

export interface SnapSettings {
    active: boolean;
    move: number;   // Grid units (e.g. 0.5)
    rotate: number; // Degrees (e.g. 15)
    scale: number;  // Factor (e.g. 0.1)
}

export const DEFAULT_UI_CONFIG: UIConfiguration = {
    windowBorderRadius: 8,
    resizeHandleThickness: 6,
    resizeHandleColor: '#4f80f8',
    resizeHandleOpacity: 0.2,
    resizeHandleLength: 1.0,
    selectionEdgeHighlight: true,
    selectionEdgeColor: '#4f80f8', // Unity Blue
    vertexSize: 1.0,
    vertexColor: '#a855f7', // Purple
    vertexShape: 'DOT'
};

export const DEFAULT_GRID_CONFIG: GridConfiguration = {
    visible: true,
    size: 1.0,         // 1 Meter primary lines
    subdivisions: 10,  // 10cm sub-divisions (Maya style)
    opacity: 0.9,      // Default 0.9
    fadeDistance: 400.0,
    color: '#808080',
    excludeFromPostProcess: false
};

export const DEFAULT_SNAP_CONFIG: SnapSettings = {
    active: false,
    move: 0.5,
    rotate: 15.0,
    scale: 0.1
};

export interface EditorContextType {
  entities: Entity[];
  sceneGraph: SceneGraph;
  
  // Entity Selection
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;

  // Asset Selection
  selectedAssetIds: string[];
  setSelectedAssetIds: (ids: string[]) => void;

  // Graph Node Selection (For Inspector/Spreadsheet)
  inspectedNode: GraphNode | null;
  setInspectedNode: (node: GraphNode | null) => void;
  activeGraphConnections: GraphConnection[];
  setActiveGraphConnections: (conns: GraphConnection[]) => void;
  updateInspectedNodeData: (key: string, value: any) => void;
  
  // Graph Sync (Inspector -> NodeGraph)
  onNodeDataChange: (nodeId: string, key: string, value: any) => void;
  setOnNodeDataChange: (cb: (nodeId: string, key: string, value: any) => void) => void;

  selectionType: SelectionType;
  setSelectionType: (type: SelectionType) => void;

  // Maya-style Mesh Interaction mode
  meshComponentMode: MeshComponentMode;
  setMeshComponentMode: (mode: MeshComponentMode) => void;

  tool: ToolType;
  setTool: (tool: ToolType) => void;
  transformSpace: TransformSpace;
  setTransformSpace: (space: TransformSpace) => void;
  isPlaying: boolean;
  

  uiConfig: UIConfiguration;
  setUiConfig: (config: UIConfiguration) => void;

  gridConfig: GridConfiguration;
  setGridConfig: (config: GridConfiguration) => void;

  snapSettings: SnapSettings;
  setSnapSettings: (settings: SnapSettings) => void;
}

export const EditorContext = React.createContext<EditorContextType | null>(null);
