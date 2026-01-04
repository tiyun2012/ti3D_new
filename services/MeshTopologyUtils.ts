
import { LogicalMesh, Vector3, MeshTopology, HalfEdge } from '../types';
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
     * Builds a Half-Edge Data Structure from a LogicalMesh.
     */
    buildTopology: (mesh: LogicalMesh, vertexCount: number): MeshTopology => {
        const halfEdges: HalfEdge[] = [];
        const vertices = new Array(vertexCount).fill(null).map(() => ({ edge: -1 }));
        const faces = new Array(mesh.faces.length).fill(null).map(() => ({ edge: -1 }));
        const edgeKeyToHalfEdge = new Map<string, number>();

        mesh.faces.forEach((faceVerts, faceIdx) => {
            const faceStartEdgeIdx = halfEdges.length;
            const len = faceVerts.length;

            for (let i = 0; i < len; i++) {
                const vCurrent = faceVerts[i];
                const vNext = faceVerts[(i + 1) % len];
                
                const heIdx = halfEdges.length;
                const he: HalfEdge = {
                    id: heIdx,
                    vertex: vNext, // Points TO vNext
                    pair: -1,
                    next: faceStartEdgeIdx + ((i + 1) % len),
                    prev: faceStartEdgeIdx + ((i - 1 + len) % len),
                    face: faceIdx,
                    edgeKey: [vCurrent, vNext].sort((a,b)=>a-b).join('-')
                };

                halfEdges.push(he);
                
                if (vertices[vCurrent].edge === -1) {
                    vertices[vCurrent].edge = heIdx;
                }

                // Register for pair matching
                const key = `${vCurrent}-${vNext}`;
                edgeKeyToHalfEdge.set(key, heIdx);
            }
            
            faces[faceIdx].edge = faceStartEdgeIdx;
        });

        // Link Pairs
        for (let i = 0; i < halfEdges.length; i++) {
            const he = halfEdges[i];
            const origin = halfEdges[he.prev].vertex;
            const dest = he.vertex;
            const pairKey = `${dest}-${origin}`; // Opposite direction
            
            if (edgeKeyToHalfEdge.has(pairKey)) {
                he.pair = edgeKeyToHalfEdge.get(pairKey)!;
            }
        }

        return { halfEdges, vertices, faces, edgeKeyToHalfEdge };
    },

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
     * Robust raycasting using AABB pre-filtering.
     */
    raycastMesh: (mesh: LogicalMesh, vertices: Float32Array, ray: Ray, tolerance: number = 0.02): MeshPickingResult | null => {
        let bestT = Infinity;
        let result: MeshPickingResult | null = null;
        
        // Use cached BVH or build it
        let bvh = mesh.bvh;
        if (!bvh) {
            bvh = MeshTopologyUtils.buildBVH(mesh, vertices);
            mesh.bvh = bvh;
        }

        mesh.faces.forEach((face, fIdx) => {
            const box = bvh.faceBounds[fIdx];
            if (RayUtils.intersectAABB(ray, box) === null) return;

            // Triangulate face for intersection test
            for (let i = 1; i < face.length - 1; i++) {
                const v0 = { x: vertices[face[0]*3], y: vertices[face[0]*3+1], z: vertices[face[0]*3+2] };
                const v1 = { x: vertices[face[i]*3], y: vertices[face[i]*3+1], z: vertices[face[i]*3+2] };
                const v2 = { x: vertices[face[i+1]*3], y: vertices[face[i+1]*3+1], z: vertices[face[i+1]*3+2] };
                
                const t = RayUtils.intersectTriangle(ray, v0, v1, v2);
                if (t !== null && t < bestT) {
                    bestT = t;
                    const hitPos = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, t, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                    
                    // Determine Closest Element
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

    // --- SELECTION ALGORITHMS ---

    /**
     * Get Edge Ring: Parallel edges (Like ladder rungs).
     */
    getEdgeRing: (mesh: LogicalMesh, startVertexA: number, startVertexB: number): [number, number][] => {
        const forward = MeshTopologyUtils._walkRing(mesh, startVertexA, startVertexB);
        const backward = MeshTopologyUtils._walkRing(mesh, startVertexA, startVertexB, true);
        return [...backward.reverse(), [startVertexA, startVertexB], ...forward];
    },

    /**
     * Get Face Loop: A strip of quads.
     */
    getFaceLoop: (mesh: LogicalMesh, edgeV1: number, edgeV2: number): number[] => {
        const faces = (mesh.vertexToFaces.get(edgeV1) || []).filter(f => (mesh.vertexToFaces.get(edgeV2) || []).includes(f));
        const loop: number[] = [];
        if (faces.length > 0) {
            loop.push(...MeshTopologyUtils._walkFaceStrip(mesh, edgeV1, edgeV2, faces[0]).reverse());
        }
        if (faces.length > 1) {
            loop.push(...MeshTopologyUtils._walkFaceStrip(mesh, edgeV1, edgeV2, faces[1]));
        }
        return [...new Set(loop)];
    },

    /**
     * Get Edge Loop: Connected edges in a line (Longitudinal).
     */
    getEdgeLoop: (mesh: LogicalMesh, startV1: number, startV2: number): [number, number][] => {
        const forward = MeshTopologyUtils._walkEdgeLoop(mesh, startV1, startV2);
        const backward = MeshTopologyUtils._walkEdgeLoop(mesh, startV2, startV1);
        // Combine: backward (reversed) -> start -> forward
        return [...backward.map(e => [e[1], e[0]] as [number, number]).reverse(), [startV1, startV2], ...forward];
    },

    /**
     * Get Vertex Loop: Vertices along the edge loop defined by v1-v2.
     * Takes 2 vertices to define the initial direction.
     */
    getVertexLoop: (mesh: LogicalMesh, v1: number, v2: number): number[] => {
        const edgeLoop = MeshTopologyUtils.getEdgeLoop(mesh, v1, v2);
        const vertices = new Set<number>();
        edgeLoop.forEach(e => { vertices.add(e[0]); vertices.add(e[1]); });
        return Array.from(vertices);
    },

    // --- Internal Helpers ---

    _walkRing: (mesh: LogicalMesh, vA: number, vB: number, reverse: boolean = false): [number, number][] => {
        const edges: [number, number][] = [];
        const visitedFaces = new Set<number>();
        
        let currA = vA; 
        let currB = vB;

        const sharedFaces = (mesh.vertexToFaces.get(vA) || []).filter(f => (mesh.vertexToFaces.get(vB) || []).includes(f));
        if (sharedFaces.length === 0) return [];
        
        // Directionality
        let startFaceIdx = reverse ? sharedFaces[1] : sharedFaces[0];
        if (startFaceIdx === undefined) return [];

        visitedFaces.add(startFaceIdx);

        let next = MeshTopologyUtils._stepAcrossFace(mesh, currA, currB, startFaceIdx);
        
        while (next) {
            edges.push([next.a, next.b]);
            currA = next.a; 
            currB = next.b;
            
            const nextFaces = (mesh.vertexToFaces.get(currA) || []).filter(f => (mesh.vertexToFaces.get(currB) || []).includes(f));
            const nextFaceIdx = nextFaces.find(f => !visitedFaces.has(f));
            
            if (nextFaceIdx === undefined) break;
            
            visitedFaces.add(nextFaceIdx);
            next = MeshTopologyUtils._stepAcrossFace(mesh, currA, currB, nextFaceIdx);
        }
        return edges;
    },

    _stepAcrossFace: (mesh: LogicalMesh, vA: number, vB: number, faceIdx: number) => {
        const face = mesh.faces[faceIdx];
        if (face.length !== 4) return null; // Only works on quads
        const idxA = face.indexOf(vA);
        const idxB = face.indexOf(vB);
        // Opposite edge in a quad: (0,1) -> (2,3)
        const nextA = face[(idxA + 2) % 4];
        const nextB = face[(idxB + 2) % 4];
        return { a: nextA, b: nextB };
    },

    _walkFaceStrip: (mesh: LogicalMesh, vA: number, vB: number, startFaceIdx: number): number[] => {
        const faces: number[] = [startFaceIdx];
        const visited = new Set<number>([startFaceIdx]);
        
        let currA = vA;
        let currB = vB;
        let currFace = startFaceIdx;

        while (true) {
            const nextEdge = MeshTopologyUtils._stepAcrossFace(mesh, currA, currB, currFace);
            if (!nextEdge) break;

            currA = nextEdge.a;
            currB = nextEdge.b;

            const candidates = (mesh.vertexToFaces.get(currA) || []).filter(f => (mesh.vertexToFaces.get(currB) || []).includes(f));
            const nextFace = candidates.find(f => !visited.has(f));

            if (nextFace === undefined) break;
            
            visited.add(nextFace);
            faces.push(nextFace);
            currFace = nextFace;
        }
        return faces;
    },

    _walkEdgeLoop: (mesh: LogicalMesh, fromV: number, currV: number): [number, number][] => {
        const loop: [number, number][] = [];
        let prev = fromV;
        let current = currV;
        
        let iter = 0;
        while(iter++ < 1000) {
            const neighborFaces = mesh.vertexToFaces.get(current) || [];
            
            // Get all directly connected neighbor vertices via edges
            const neighbors = new Set<number>();
            neighborFaces.forEach(fIdx => {
                const face = mesh.faces[fIdx];
                const idx = face.indexOf(current);
                neighbors.add(face[(idx + 1) % face.length]);
                neighbors.add(face[(idx + face.length - 1) % face.length]);
            });

            // Incoming edge is (prev, current)
            const incomingFaces = neighborFaces.filter(fIdx => mesh.faces[fIdx].includes(prev));

            // Find 'next' such that edge (current, next) shares NO faces with (prev, current)
            let nextVertex = -1;
            
            for (const n of Array.from(neighbors)) {
                if (n === prev) continue;
                
                const outgoingFaces = neighborFaces.filter(fIdx => mesh.faces[fIdx].includes(n));
                const shared = incomingFaces.filter(f => outgoingFaces.includes(f));
                
                // If 0 shared faces, this edge is topologically opposite in a valence-4 vertex
                if (shared.length === 0) {
                    nextVertex = n;
                    break; 
                }
            }

            if (nextVertex !== -1) {
                loop.push([current, nextVertex]);
                prev = current;
                current = nextVertex;
            } else {
                break; // Pole or boundary
            }
        }
        return loop;
    },

    computeSurfaceWeights: (
        indices: Uint16Array | Uint32Array,
        vertices: Float32Array,
        selectedIndices: Set<number>,
        radius: number,
        vertexCount: number
    ): Float32Array => {
        const weights = new Float32Array(vertexCount).fill(0);
        if (selectedIndices.size === 0) return weights;

        const adj: number[][] = new Array(vertexCount);
        for(let i=0; i<vertexCount; i++) adj[i] = [];

        for (let i = 0; i < indices.length; i += 3) {
            const v0 = indices[i];
            const v1 = indices[i+1];
            const v2 = indices[i+2];
            
            if (adj[v0].indexOf(v1) === -1) adj[v0].push(v1);
            if (adj[v1].indexOf(v0) === -1) adj[v1].push(v0);
            
            if (adj[v1].indexOf(v2) === -1) adj[v1].push(v2);
            if (adj[v2].indexOf(v1) === -1) adj[v2].push(v1);
            
            if (adj[v2].indexOf(v0) === -1) adj[v2].push(v0);
            if (adj[v0].indexOf(v2) === -1) adj[v0].push(v2);
        }

        const dists = new Float32Array(vertexCount).fill(Infinity);
        const pq = new MinHeap();

        selectedIndices.forEach(idx => {
            dists[idx] = 0;
            weights[idx] = 1.0;
            pq.push({ id: idx, dist: 0 });
        });

        let iterations = 0;
        const MAX_ITER = vertexCount * 10; 

        while (pq.length > 0 && iterations++ < MAX_ITER) {
            const u = pq.pop()!;
            if (u.dist > dists[u.id]) continue;
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

        for (let i = 0; i < vertexCount; i++) {
            if (dists[i] <= radius) {
                if (radius <= 0.0001) {
                    weights[i] = dists[i] === 0 ? 1.0 : 0.0;
                } else {
                    const t = 1.0 - (dists[i] / radius);
                    weights[i] = t * t * (3 - 2 * t);
                }
            } else {
                weights[i] = 0.0;
            }
        }

        return weights;
    }
};
