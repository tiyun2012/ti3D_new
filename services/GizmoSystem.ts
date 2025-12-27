import { engineInstance } from './engine';
import { Mat4Utils, Vec3Utils } from './math';
import { Vector3, ToolType } from '../types';

export type GizmoAxis = 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ' | 'VIEW' | null;

export class GizmoSystem {
    activeAxis: GizmoAxis = null;
    hoverAxis: GizmoAxis = null;
    
    // Config
    private tool: ToolType = 'SELECT'; // Default to SELECT (Hidden)
    private gizmoScale = 1.0;

    // Drag State
    private isDragging = false;
    private startPos: Vector3 = { x: 0, y: 0, z: 0 };
    private clickOffset: Vector3 = { x: 0, y: 0, z: 0 };
    private planeNormal: Vector3 = { x: 0, y: 1, z: 0 };
    
    // --- API ---
    setTool(tool: ToolType) {
        this.tool = tool;
        // If we switch to SELECT while dragging, cancel the drag
        if (tool === 'SELECT' && this.isDragging) {
            this.isDragging = false;
            this.activeAxis = null;
        }
    }

    update(dt: number, mx: number, my: number, width: number, height: number, isDown: boolean, isUp: boolean) {
        // 1. Tool Check: If SELECT, do nothing (allow box selection to pass through)
        if (this.tool === 'SELECT') {
            this.hoverAxis = null;
            this.activeAxis = null;
            return;
        }

        const selected = engineInstance.selectedIndices;
        if (selected.size !== 1) return; 
        
        const idx = Array.from(selected)[0];
        const entityId = engineInstance.ecs.store.ids[idx];
        if (!entityId) return;

        const worldPos = engineInstance.sceneGraph.getWorldPosition(entityId);
        const camPos = engineInstance.currentCameraPos;
        
        const dist = Math.sqrt((camPos.x-worldPos.x)**2 + (camPos.y-worldPos.y)**2 + (camPos.z-worldPos.z)**2);
        this.gizmoScale = dist * 0.15;

        const vp = engineInstance.currentViewProj;
        if (!vp) return;
        const invVP = new Float32Array(16);
        if (!Mat4Utils.invert(vp, invVP)) return;

        const ray = this.screenToRay(mx, my, width, height, invVP, camPos);

        if (this.isDragging) {
            if (isUp) {
                this.isDragging = false;
                this.activeAxis = null;
                engineInstance.pushUndoState();
            } else {
                this.handleDrag(ray, entityId);
            }
        } else {
            this.hoverAxis = this.raycastGizmo(ray, worldPos, this.gizmoScale);
            
            if (isDown && this.hoverAxis) {
                this.isDragging = true;
                this.activeAxis = this.hoverAxis;
                this.startDrag(ray, worldPos);
            }
        }
    }

    render() {
        // 1. Tool Check: If SELECT, do not render
        if (this.tool === 'SELECT') return;

        const selected = engineInstance.selectedIndices;
        if (selected.size !== 1) return;
        const idx = Array.from(selected)[0];
        const pos = {
            x: engineInstance.ecs.store.worldMatrix[idx*16 + 12],
            y: engineInstance.ecs.store.worldMatrix[idx*16 + 13],
            z: engineInstance.ecs.store.worldMatrix[idx*16 + 14]
        };
        
        if (engineInstance.currentViewProj) {
            engineInstance.renderer.renderGizmos(
                engineInstance.currentViewProj, 
                pos, 
                this.gizmoScale, 
                this.hoverAxis as string, 
                this.activeAxis as string
            );
        }
    }

    private startDrag(ray: any, pos: Vector3) {
        this.startPos = { ...pos };
        const axis = this.activeAxis;
        const viewDir = Vec3Utils.normalize(Vec3Utils.subtract(engineInstance.currentCameraPos, pos, {x:0,y:0,z:0}), {x:0,y:0,z:0});
        
        const X = {x:1,y:0,z:0}; const Y = {x:0,y:1,z:0}; const Z = {x:0,y:0,z:1};
        
        if (axis === 'X') this.planeNormal = Math.abs(viewDir.y) > Math.abs(viewDir.z) ? Y : Z;
        else if (axis === 'Y') this.planeNormal = Math.abs(viewDir.x) > Math.abs(viewDir.z) ? X : Z;
        else if (axis === 'Z') this.planeNormal = Math.abs(viewDir.x) > Math.abs(viewDir.y) ? X : Y;
        else if (axis === 'XY') this.planeNormal = Z;
        else if (axis === 'XZ') this.planeNormal = Y;
        else if (axis === 'YZ') this.planeNormal = X;
        else if (axis === 'VIEW') this.planeNormal = viewDir;

        const hit = this.rayPlaneIntersect(ray, pos, this.planeNormal);
        if (hit) {
            this.clickOffset = Vec3Utils.subtract(hit, pos, {x:0,y:0,z:0});
        }
    }

    private handleDrag(ray: any, entityId: string) {
        const hit = this.rayPlaneIntersect(ray, this.startPos, this.planeNormal);
        if (hit) {
            let target = Vec3Utils.subtract(hit, this.clickOffset, {x:0,y:0,z:0});
            
            // Apply Constraints (If NOT free view/plane)
            if (this.activeAxis === 'X') target = { x: target.x, y: this.startPos.y, z: this.startPos.z };
            if (this.activeAxis === 'Y') target = { x: this.startPos.x, y: target.y, z: this.startPos.z };
            if (this.activeAxis === 'Z') target = { x: this.startPos.x, y: this.startPos.y, z: target.z };
            if (this.activeAxis === 'XY') target.z = this.startPos.z;
            if (this.activeAxis === 'XZ') target.y = this.startPos.y;
            if (this.activeAxis === 'YZ') target.x = this.startPos.x;

            this.setWorldPosition(entityId, target);
            engineInstance.syncTransforms(); 
        }
    }

    private setWorldPosition(entityId: string, targetWorldPos: Vector3) {
        const parentId = engineInstance.sceneGraph.getParentId(entityId);
        const parentMat = Mat4Utils.create();
        if (parentId) {
            const pm = engineInstance.sceneGraph.getWorldMatrix(parentId);
            if (pm) Mat4Utils.copy(parentMat, pm);
        }
        const invParent = Mat4Utils.create();
        Mat4Utils.invert(parentMat, invParent);
        
        const localPos = Vec3Utils.create();
        Vec3Utils.transformMat4(targetWorldPos, invParent, localPos);
        
        const idx = engineInstance.ecs.getEntityIndex(entityId);
        if (idx !== undefined) {
             engineInstance.ecs.store.setPosition(idx, localPos.x, localPos.y, localPos.z);
             engineInstance.sceneGraph.setDirty(entityId);
        }
    }

    // --- Math Helpers ---
    private raycastGizmo(ray: any, pos: Vector3, scale: number): GizmoAxis {
        // 0. Center Ball
        const ballRad = scale * 0.02; 
        if (this.distRaySegment(ray, pos, pos) < ballRad) return 'VIEW';

        // 1. Axes
        const len = scale * 0.67;  
        const rad = scale * 0.00625; 
        const distToAxis = (axisVec: Vector3) => {
            const end = Vec3Utils.add(pos, Vec3Utils.scale(axisVec, len, {x:0,y:0,z:0}), {x:0,y:0,z:0});
            return this.distRaySegment(ray, pos, end);
        };

        if (distToAxis({x:1,y:0,z:0}) < rad) return 'X';
        if (distToAxis({x:0,y:1,z:0}) < rad) return 'Y';
        if (distToAxis({x:0,y:0,z:1}) < rad) return 'Z';
        
        // 2. Planes
        const pStart = scale * 0.1;
        const pEnd = scale * 0.2; 
        const checkPlane = (normal: Vector3, uAxis: Vector3, vAxis: Vector3): boolean => {
            const hit = this.rayPlaneIntersect(ray, pos, normal);
            if (!hit) return false;
            const loc = Vec3Utils.subtract(hit, pos, {x:0,y:0,z:0});
            const u = Vec3Utils.dot(loc, uAxis);
            const v = Vec3Utils.dot(loc, vAxis);
            return (u >= pStart && u <= pEnd && v >= pStart && v <= pEnd);
        };

        if (checkPlane({x:0,y:0,z:1}, {x:1,y:0,z:0}, {x:0,y:1,z:0})) return 'XY';
        if (checkPlane({x:0,y:1,z:0}, {x:1,y:0,z:0}, {x:0,y:0,z:1})) return 'XZ';
        if (checkPlane({x:1,y:0,z:0}, {x:0,y:1,z:0}, {x:0,y:0,z:1})) return 'YZ';

        return null;
    }

    private screenToRay(mx: number, my: number, w: number, h: number, invVP: Float32Array, camPos: Vector3) {
        const x = (mx / w) * 2 - 1;
        const y = -(my / h) * 2 + 1;
        const world = [0,0,0,0];
        world[0] = invVP[0]*x + invVP[4]*y + invVP[8] + invVP[12];
        world[1] = invVP[1]*x + invVP[5]*y + invVP[9] + invVP[13];
        world[2] = invVP[2]*x + invVP[6]*y + invVP[10] + invVP[14];
        world[3] = invVP[3]*x + invVP[7]*y + invVP[11] + invVP[15];
        if (world[3] !== 0) { world[0]/=world[3]; world[1]/=world[3]; world[2]/=world[3]; }
        const dir = Vec3Utils.normalize(Vec3Utils.subtract({x:world[0],y:world[1],z:world[2]}, camPos, {x:0,y:0,z:0}), {x:0,y:0,z:0});
        return { origin: camPos, direction: dir };
    }
    
    private distRaySegment(ray: any, v0: Vector3, v1: Vector3): number {
        const rOrigin = ray.origin; const rDir = ray.direction;
        const v10 = Vec3Utils.subtract(v1, v0, {x:0,y:0,z:0});
        const v0r = Vec3Utils.subtract(v0, rOrigin, {x:0,y:0,z:0});
        const dotA = Vec3Utils.dot(v10, v10);
        const dotB = Vec3Utils.dot(v10, rDir);
        const dotC = Vec3Utils.dot(v10, v0r);
        const dotD = Vec3Utils.dot(rDir, rDir);
        const dotE = Vec3Utils.dot(rDir, v0r);
        const denom = dotA*dotD - dotB*dotB;
        let sc, tc;
        if (denom < 0.000001) { sc = 0; tc = (dotB > dotC ? dotE/dotB : 0); }
        else { sc = (dotB*dotE - dotC*dotD) / denom; tc = (dotA*dotE - dotB*dotC) / denom; }
        sc = Math.max(0, Math.min(1, sc));
        tc = (dotB*sc + dotE) / dotD;
        const pSeg = Vec3Utils.add(v0, Vec3Utils.scale(v10, sc, {x:0,y:0,z:0}), {x:0,y:0,z:0});
        const pRay = Vec3Utils.add(rOrigin, Vec3Utils.scale(rDir, tc, {x:0,y:0,z:0}), {x:0,y:0,z:0});
        const diff = Vec3Utils.subtract(pSeg, pRay, {x:0,y:0,z:0});
        return Math.sqrt(Vec3Utils.dot(diff, diff));
    }

    private rayPlaneIntersect(ray: any, planePoint: Vector3, planeNormal: Vector3): Vector3 | null {
        const denom = Vec3Utils.dot(planeNormal, ray.direction);
        if (Math.abs(denom) < 0.0001) return null;
        const t = Vec3Utils.dot(Vec3Utils.subtract(planePoint, ray.origin, {x:0,y:0,z:0}), planeNormal) / denom;
        if (t < 0) return null;
        return Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, t, {x:0,y:0,z:0}), {x:0,y:0,z:0});
    }
}

export const gizmoSystem = new GizmoSystem();