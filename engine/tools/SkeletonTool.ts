import { engineInstance } from '../engine';
import { assetManager } from '../AssetManager';
import { SkeletonAsset, SkeletalMeshAsset } from '@/types';

export interface SkeletonToolOptions {
    enabled: boolean;
    drawJoints: boolean;
    drawBones: boolean;

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

        const transform = (x: number, y: number, z: number) => ({
            x: worldMat[0] * x + worldMat[4] * y + worldMat[8] * z + worldMat[12],
            y: worldMat[1] * x + worldMat[5] * y + worldMat[9] * z + worldMat[13],
            z: worldMat[2] * x + worldMat[6] * y + worldMat[10] * z + worldMat[14]
        });

        const debug = engineInstance.debugRenderer;
        const bones = skeleton.bones;

        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            const p = (bone as any).parentIndex;
            const isRoot = p === -1 || p === undefined || p === null;

            // Bind-pose translation -> world space
            const pos = transform(bone.bindPose[12], bone.bindPose[13], bone.bindPose[14]);

            if (this.options.drawJoints) {
                let r = this.options.jointRadius;
                const mult = bone.visual?.size ?? 1.0;
                r *= mult;
                if (isRoot) r *= this.options.rootScale;

                // Root is always highlighted with rootColor (ignores per-bone visual color)
                let color = isRoot ? this.options.rootColor : { r: 1, g: 0.5, b: 0 };

                if (!isRoot && bone.visual?.color) {
                    const c = bone.visual.color;
                    color = { r: c.x ?? c[0] ?? color.r, g: c.y ?? c[1] ?? color.g, b: c.z ?? c[2] ?? color.b };
                }

                debug.drawPoint(pos, color, r, this.options.border);
            }

            if (this.options.drawBones && !isRoot && typeof p === 'number' && p >= 0 && p < bones.length) {
                const parent = bones[p];
                if (parent?.bindPose) {
                    const pPos = transform(parent.bindPose[12], parent.bindPose[13], parent.bindPose[14]);
                    debug.drawLine(pPos, pos, this.options.boneColor);
                }
            }
        }
    }
}

export const skeletonTool = new SkeletonTool();
