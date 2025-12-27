
import { LogicalMesh, Vector3 } from '../types';
/* Ray is exported from ./math, not ../types */
import { Vec3Utils, RayUtils, AABB, Ray } from './math';

export interface MeshPickingResult {
    t: number;
    vertexId: number;
    edgeId: [number, number];
    faceId: number;
    worldPos: Vector3;
}

export const MeshTopologyUtils = {
    /**
     * Efficiently builds face-level bounding boxes for mesh raycasting.
     */
    buildBVH: (mesh: LogicalMesh, vertices: Float32Array): { faceBounds: AABB[] } => {
        const faceBounds: AABB[] = mesh.faces.map(face => {
            let min = {x:Infinity, y:Infinity, z:Infinity};
            let max = {x:-Infinity, y:-Infinity, z:-Infinity};
            face.forEach(vIdx => {
                const px = vertices[vIdx*3], py = vertices[vIdx*3+1], pz = vertices[vIdx*3+2];
                min.x = Math.min(min.x, px); min.y = Math.min(min.y, py); min.z = Math.min(min.z, pz);
                max.x = Math.max(max.x, px); max.y = Math.max(max.y, py); max.z = Math.max(max.z, pz);
            });
            return { min, max };
        });
        return { faceBounds };
    },

    /**
     * Robust raycasting using AABB pre-filtering for sub-millisecond detection on high-res meshes.
     */
    raycastMesh: (mesh: LogicalMesh, vertices: Float32Array, ray: Ray, tolerance: number = 0.02): MeshPickingResult | null => {
        let bestT = Infinity;
        let result: MeshPickingResult | null = null;
        
        const bvh = MeshTopologyUtils.buildBVH(mesh, vertices);

        mesh.faces.forEach((face, fIdx) => {
            const box = bvh.faceBounds[fIdx];
            if (RayUtils.intersectAABB(ray, box) === null) return;

            for (let i = 1; i < face.length - 1; i++) {
                const v0 = { x: vertices[face[0]*3], y: vertices[face[0]*3+1], z: vertices[face[0]*3+2] };
                const v1 = { x: vertices[face[i]*3], y: vertices[face[i]*3+1], z: vertices[face[i]*3+2] };
                const v2 = { x: vertices[face[i+1]*3], y: vertices[face[i+1]*3+1], z: vertices[face[i+1]*3+2] };
                
                const t = RayUtils.intersectTriangle(ray, v0, v1, v2);
                if (t !== null && t < bestT) {
                    bestT = t;
                    const hitPos = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, t, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                    
                    let closestV = -1;
                    let minDistV = tolerance;
                    face.forEach(vIdx => {
                        const vp = { x: vertices[vIdx*3], y: vertices[vIdx*3+1], z: vertices[vIdx*3+2] };
                        const d = Vec3Utils.distance(hitPos, vp);
                        if (d < minDistV) { minDistV = d; closestV = vIdx; }
                    });

                    let closestEdge: [number, number] = [face[0], face[1]];
                    let minDistE = tolerance;
                    for(let k=0; k<face.length; k++) {
                        const vA = face[k]; const vB = face[(k+1)%face.length];
                        const pA = { x: vertices[vA*3], y: vertices[vA*3+1], z: vertices[vA*3+2] };
                        const pB = { x: vertices[vB*3], y: vertices[vB*3+1], z: vertices[vB*3+2] };
                        const d = RayUtils.distRaySegment(ray, pA, pB);
                        if (d < minDistE) { minDistE = d; closestEdge = [vA, vB]; }
                    }

                    result = { t, faceId: fIdx, vertexId: closestV, edgeId: closestEdge, worldPos: hitPos };
                }
            }
        });

        return result;
    },

    getEdgeLoop: (mesh: LogicalMesh, startVertexA: number, startVertexB: number): [number, number][] => {
        const loop: [number, number][] = [[startVertexA, startVertexB]];
        const visitedFaces = new Set<number>();
        let currentA = startVertexA;
        let currentB = startVertexB;
        let next = MeshTopologyUtils.walkLoop(mesh, currentA, currentB, visitedFaces);
        while (next) {
            loop.push([next.a, next.b]);
            currentA = next.a; currentB = next.b;
            next = MeshTopologyUtils.walkLoop(mesh, currentA, currentB, visitedFaces);
        }
        return loop;
    },

    walkLoop: (mesh: LogicalMesh, vA: number, vB: number, visited: Set<number>) => {
        const facesA = mesh.vertexToFaces.get(vA) || [];
        const facesB = mesh.vertexToFaces.get(vB) || [];
        const sharedFaceIdx = facesA.find(fIdx => !visited.has(fIdx) && facesB.includes(fIdx));
        if (sharedFaceIdx === undefined) return null;
        const face = mesh.faces[sharedFaceIdx];
        if (face.length !== 4) return null;
        visited.add(sharedFaceIdx);
        const idxA = face.indexOf(vA);
        const idxB = face.indexOf(vB);
        const nextA = face[(idxA + 2) % 4];
        const nextB = face[(idxB + 2) % 4];
        return { a: nextA, b: nextB };
    }
};
