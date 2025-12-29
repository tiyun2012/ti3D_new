
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

// Minimal MinHeap for Dijkstra priority queue
class MinHeap {
    heap: {id: number, dist: number}[];
    
    constructor() { this.heap = []; }
    
    push(node: {id: number, dist: number}) {
        this.heap.push(node);
        this.bubbleUp(this.heap.length - 1);
    }
    
    pop(): {id: number, dist: number} | undefined {
        if (this.heap.length === 0) return undefined;
        const top = this.heap[0];
        const bottom = this.heap.pop();
        if (this.heap.length > 0 && bottom) {
            this.heap[0] = bottom;
            this.bubbleDown(0);
        }
        return top;
    }
    
    bubbleUp(index: number) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.heap[index].dist >= this.heap[parentIndex].dist) break;
            [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
            index = parentIndex;
        }
    }
    
    bubbleDown(index: number) {
        while (true) {
            const leftChild = 2 * index + 1;
            const rightChild = 2 * index + 2;
            let smallest = index;
            
            if (leftChild < this.heap.length && this.heap[leftChild].dist < this.heap[smallest].dist) {
                smallest = leftChild;
            }
            if (rightChild < this.heap.length && this.heap[rightChild].dist < this.heap[smallest].dist) {
                smallest = rightChild;
            }
            if (smallest === index) break;
            
            [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
            index = smallest;
        }
    }
    
    get length() { return this.heap.length; }
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
    },

    /**
     * Calculates Soft Selection weights using Surface Distance (Geodesic).
     * Builds an adjacency graph on-the-fly and runs Dijkstra's algorithm.
     * Uses a MinHeap for performance O(E log V).
     */
    computeSurfaceWeights: (
        indices: Uint16Array | Uint32Array,
        vertices: Float32Array,
        selectedIndices: Set<number>,
        radius: number,
        vertexCount: number
    ): Float32Array => {
        const weights = new Float32Array(vertexCount).fill(0);
        if (selectedIndices.size === 0) return weights;

        // 1. Build Adjacency Graph
        // Using sparse array of arrays for adjacency to save memory vs matrix
        const adj: number[][] = new Array(vertexCount);
        for(let i=0; i<vertexCount; i++) adj[i] = [];

        // Pre-allocate check to prevent heavy duplicates (simple check is enough for triangles)
        for (let i = 0; i < indices.length; i += 3) {
            const v0 = indices[i];
            const v1 = indices[i+1];
            const v2 = indices[i+2];
            
            // Add edges (undirected), basic deduplication check
            // Note: For very high poly meshes, even this indexOf can be slow if degree is high, 
            // but for triangle meshes degree is usually ~6, so it's negligible.
            if (adj[v0].indexOf(v1) === -1) adj[v0].push(v1);
            if (adj[v1].indexOf(v0) === -1) adj[v1].push(v0);
            
            if (adj[v1].indexOf(v2) === -1) adj[v1].push(v2);
            if (adj[v2].indexOf(v1) === -1) adj[v2].push(v1);
            
            if (adj[v2].indexOf(v0) === -1) adj[v2].push(v0);
            if (adj[v0].indexOf(v2) === -1) adj[v0].push(v2);
        }

        // 2. Initialize Dijkstra
        const dists = new Float32Array(vertexCount).fill(Infinity);
        const pq = new MinHeap();

        selectedIndices.forEach(idx => {
            dists[idx] = 0;
            weights[idx] = 1.0;
            pq.push({ id: idx, dist: 0 });
        });

        // 3. Process Queue
        // Limit iterations as a failsafe for degenerate geometry/infinite loops
        let iterations = 0;
        const MAX_ITER = vertexCount * 10; 

        while (pq.length > 0 && iterations++ < MAX_ITER) {
            const u = pq.pop()!;
            
            // Stale entry check
            if (u.dist > dists[u.id]) continue;
            
            // Optimization: Don't propagate beyond radius
            // We still process the node to find neighbors that might be closer to source via this path,
            // but if u.dist > radius, any neighbor v will have dist > radius too, so we can prune.
            if (u.dist > radius) continue;

            const neighbors = adj[u.id];
            const uPos = { x: vertices[u.id*3], y: vertices[u.id*3+1], z: vertices[u.id*3+2] };

            for (let i = 0; i < neighbors.length; i++) {
                const v = neighbors[i];
                const vPos = { x: vertices[v*3], y: vertices[v*3+1], z: vertices[v*3+2] };
                const edgeLen = Math.sqrt((uPos.x - vPos.x)**2 + (uPos.y - vPos.y)**2 + (uPos.z - vPos.z)**2);
                
                const alt = u.dist + edgeLen;
                
                if (alt < dists[v] && alt <= radius) {
                    dists[v] = alt;
                    pq.push({ id: v, dist: alt });
                }
            }
        }

        // 4. Convert Distances to Weights
        for (let i = 0; i < vertexCount; i++) {
            if (dists[i] <= radius) {
                // Prevent division by zero if radius is 0
                if (radius <= 0.0001) {
                    weights[i] = dists[i] === 0 ? 1.0 : 0.0;
                } else {
                    const t = 1.0 - (dists[i] / radius);
                    // SmoothStep falloff: 3t^2 - 2t^3
                    weights[i] = t * t * (3 - 2 * t);
                }
            } else {
                weights[i] = 0.0;
            }
        }

        return weights;
    }
};
