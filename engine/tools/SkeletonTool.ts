
import { engineInstance } from '../engine';
import { assetManager } from '../AssetManager';
import { SkeletonAsset, SkeletalMeshAsset } from '@/types';
import { Vec3 } from '../math';

export interface SkeletonToolOptions {
    enabled: boolean;
    drawJoints: boolean;
    drawBones: boolean;
    drawAxes: boolean; // Added

    /** Joint size in screen pixels (DebugRenderer point size). */
    jointRadius: number;

    /** Multiplier applied to the root joint size. */
    rootScale: number;

    /** Default bone line color (used when a bone has no visual.color). */
    boneColor: { r: number; g: number; b: number };

    /** Default root joint color (used when root has no visual.color). */
    rootColor: { r: number; g: number; b: number };

    /** Debug point outline thickness (0..1). */
    border: number;
}

const DEFAULT_OPTIONS: SkeletonToolOptions = {
    enabled: true,
    drawJoints: true,
    drawBones: true,
    drawAxes: false, // Default off
    jointRadius: 10,
    rootScale: 1.6,
    boneColor: { r: 0.5, g: 0.5, b: 0.5 },
    rootColor: { r: 0.2, g: 1.0, b: 0.2 },
    border: 0.2
};

export class SkeletonTool {
    private activeAssetId: string | null = null;
    private activeEntityId: string | null = null;
    private options: SkeletonToolOptions = { ...DEFAULT_OPTIONS };

    /** Preferred API: bind a Skeleton/SkeletalMesh asset to a specific scene entity for world-space drawing. */
    setActive(assetId: string | null, entityId: string | null) {
        this.activeAssetId = assetId;
        this.activeEntityId = entityId;
    }

    /** Backwards compatible: keeps current entity (if any). */
    setActiveAsset(assetId: string | null) {
        this.setActive(assetId, this.activeEntityId);
    }

    setOptions(partial: Partial<SkeletonToolOptions>) {
        this.options = { ...this.options, ...partial };
    }

    getOptions(): SkeletonToolOptions {
        return this.options;
    }

    update() {
        if (!this.options.enabled) return;
        if (!this.activeAssetId || !this.activeEntityId) return;

        const asset = assetManager.getAsset(this.activeAssetId) as (SkeletonAsset | SkeletalMeshAsset | undefined);
        if (!asset) return;

        const skeleton = (asset as any).skeleton as { bones: any[] } | undefined;
        if (!skeleton || !Array.isArray(skeleton.bones)) return;

        const worldMat = engineInstance.sceneGraph.getWorldMatrix(this.activeEntityId);
        if (!worldMat) return;

        // Manual matrix multiplication helper for points
        const transform = (x: number, y: number, z: number) => ({
            x: worldMat[0] * x + worldMat[4] * y + worldMat[8] * z + worldMat[12],
            y: worldMat[1] * x + worldMat[5] * y + worldMat[9] * z + worldMat[13],
            z: worldMat[2] * x + worldMat[6] * y + worldMat[10] * z + worldMat[14]
        });

        // Manual matrix rotation helper (ignores translation) for axes
        const rotate = (x: number, y: number, z: number) => ({
            x: worldMat[0] * x + worldMat[4] * y + worldMat[8] * z,
            y: worldMat[1] * x + worldMat[5] * y + worldMat[9] * z,
            z: worldMat[2] * x + worldMat[6] * y + worldMat[10] * z
        });

        const debug = engineInstance.debugRenderer;
        const bones = skeleton.bones;

        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            const p = (bone as any).parentIndex;
            const isRoot = p === -1 || p === undefined || p === null;

            // Extract world position from bind pose (local relative to model root) transformed by Entity World Matrix
            const bx = bone.bindPose[12];
            const by = bone.bindPose[13];
            const bz = bone.bindPose[14];
            const pos = transform(bx, by, bz);

            // Extract rotation basis vectors from bind pose
            // Column 0 = X, Column 1 = Y, Column 2 = Z
            const rx = { x: bone.bindPose[0], y: bone.bindPose[1], z: bone.bindPose[2] };
            const ry = { x: bone.bindPose[4], y: bone.bindPose[5], z: bone.bindPose[6] };
            const rz = { x: bone.bindPose[8], y: bone.bindPose[9], z: bone.bindPose[10] };

            if (this.options.drawJoints) {
                // Special handling for Root: Draw Maya-style wire sphere
                if (isRoot) {
                    const radius = 0.3 * this.options.rootScale; // World unit size approx
                    this.drawWireSphere(debug, pos, radius, this.options.rootColor);
                } else {
                    // Standard joint dot
                    let r = this.options.jointRadius;
                    const mult = bone.visual?.size ?? 1.0;
                    r *= mult;
                    
                    let color = { r: 1, g: 0.5, b: 0 };
                    if (bone.visual?.color) {
                        const c = bone.visual.color;
                        color = { r: c.x ?? c[0] ?? color.r, g: c.y ?? c[1] ?? color.g, b: c.z ?? c[2] ?? color.b };
                    }
                    debug.drawPoint(pos, color, r, this.options.border);
                }
            }

            if (this.options.drawAxes) {
                const axisScale = 0.3; // Length of debug axes
                
                // Transform local basis vectors to world space
                const wx = rotate(rx.x, rx.y, rx.z);
                const wy = rotate(ry.x, ry.y, ry.z);
                const wz = rotate(rz.x, rz.y, rz.z);

                // Draw X (Red)
                debug.drawLine(pos, { x: pos.x + wx.x * axisScale, y: pos.y + wx.y * axisScale, z: pos.z + wx.z * axisScale }, { r: 1, g: 0, b: 0 });
                // Draw Y (Green)
                debug.drawLine(pos, { x: pos.x + wy.x * axisScale, y: pos.y + wy.y * axisScale, z: pos.z + wy.z * axisScale }, { r: 0, g: 1, b: 0 });
                // Draw Z (Blue)
                debug.drawLine(pos, { x: pos.x + wz.x * axisScale, y: pos.y + wz.y * axisScale, z: pos.z + wz.z * axisScale }, { r: 0, g: 0, b: 1 });
            }

            // Draw bone connection line
            if (this.options.drawBones && !isRoot && typeof p === 'number' && p >= 0 && p < bones.length) {
                const parent = bones[p];
                if (parent?.bindPose) {
                    const pPos = transform(parent.bindPose[12], parent.bindPose[13], parent.bindPose[14]);
                    debug.drawLine(pPos, pos, this.options.boneColor);
                }
            }
        }
    }

    private drawWireSphere(debug: any, center: Vec3, radius: number, color: {r: number, g: number, b: number}) {
        const segments = 12;
        
        // Draw 3 orthogonal circles (XY, YZ, XZ)
        
        // XY Circle
        let prev = { x: center.x + radius, y: center.y, z: center.z };
        for(let i = 1; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const next = {
                x: center.x + Math.cos(theta) * radius,
                y: center.y + Math.sin(theta) * radius,
                z: center.z
            };
            debug.drawLine(prev, next, color);
            prev = next;
        }

        // YZ Circle
        prev = { x: center.x, y: center.y + radius, z: center.z };
        for(let i = 1; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const next = {
                x: center.x,
                y: center.y + Math.cos(theta) * radius,
                z: center.z + Math.sin(theta) * radius
            };
            debug.drawLine(prev, next, color);
            prev = next;
        }

        // XZ Circle
        prev = { x: center.x + radius, y: center.y, z: center.z };
        for(let i = 1; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const next = {
                x: center.x + Math.cos(theta) * radius,
                y: center.y,
                z: center.z + Math.sin(theta) * radius
            };
            debug.drawLine(prev, next, color);
            prev = next;
        }
    }
}

export const skeletonTool = new SkeletonTool();
