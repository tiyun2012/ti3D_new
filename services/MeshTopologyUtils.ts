
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
     * This enables O(1) adjacency lookups and robust loop/ring selection.
     */
    buildTopology: (mesh: LogicalMesh, vertexCount: number): MeshTopology => {
        const halfEdges: HalfEdge[] = [];
        const vertices = new Array(vertexCount).fill(null).map(() => ({ edge: -1 }));
        const faces = new Array(mesh.faces.length).fill(null).map(() => ({ edge: -1 }));
        const edgeKeyToHalfEdge = new Map<string, number>();

        // 1. Create Half-Edges for each face
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
                // Key is directed: "from-to"
                const key = `${vCurrent}-${vNext}`;
                edgeKeyToHalfEdge.set(key, heIdx);
            }
            
            faces[faceIdx].edge = faceStartEdgeIdx;
        });

        // 2. Link Pairs
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
     * Robust raycasting using AABB pre-filtering for sub-millisecond detection on high-res meshes.
     */
    raycastMesh: (mesh: LogicalMesh, vertices: Float32Array, ray: Ray, tolerance: number = 0.02): MeshPickingResult | null => {
        let bestT = Infinity;
        let result: MeshPickingResult | null = null;
        
        const bvh = MeshTopologyUtils.buildBVH(mesh, vertices);

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

    // --- LOOP SELECTION ALGORITHMS ---

    getFaceLoop: (mesh: LogicalMesh, startFace: number, guideEdgeVertices: [number, number]): number[] => {
        if (!mesh.graph) return [startFace];
        const graph = mesh.graph;
        
        const vA = guideEdgeVertices[0];
        const vB = guideEdgeVertices[1];
        
        let startHeIdx = -1;
        let key = `${vA}-${vB}`;
        
        let candidateIdx = graph.edgeKeyToHalfEdge.get(key);
        if (candidateIdx === undefined) {
             key = `${vB}-${vA}`;
             candidateIdx = graph.edgeKeyToHalfEdge.get(key);
        }
        if (candidateIdx === undefined) return [startFace];
        
        if (graph.halfEdges[candidateIdx].face === startFace) startHeIdx = candidateIdx;
        else if (graph.halfEdges[candidateIdx].pair !== -1 && graph.halfEdges[graph.halfEdges[candidateIdx].pair].face === startFace) {
            startHeIdx = graph.halfEdges[candidateIdx].pair;
        }
        
        if (startHeIdx === -1) return [startFace];

        const loop = new Set<number>();
        loop.add(startFace);

        // Walk neighbor across guide edge
        MeshTopologyUtils.walkFaceLoop(graph, startHeIdx, loop);
        
        // Walk opposite direction (opposite edge of the quad)
        const next = graph.halfEdges[startHeIdx].next;
        const opp = graph.halfEdges[next].next;
        MeshTopologyUtils.walkFaceLoop(graph, opp, loop);

        return Array.from(loop);
    },

    walkFaceLoop: (graph: MeshTopology, exitHeIdx: number, result: Set<number>) => {
        let curr = exitHeIdx;
        
        while(true) {
            const pair = graph.halfEdges[curr].pair;
            if (pair === -1) break; 
            
            const neighborFace = graph.halfEdges[pair].face;
            if (result.has(neighborFace)) break;
            
            const fEdge = graph.faces[neighborFace].edge;
            let count = 0; let it = fEdge;
            do { count++; it = graph.halfEdges[it].next; } while(it !== fEdge);
            if (count !== 4) {
                result.add(neighborFace);
                break;
            }
            
            result.add(neighborFace);
            curr = graph.halfEdges[graph.halfEdges[pair].next].next;
        }
    },

    getEdgeLoop: (mesh: LogicalMesh, startEdgeKey: string): string[] => {
        if (!mesh.graph) return [startEdgeKey];
        
        const graph = mesh.graph;
        let startHeIdx = graph.edgeKeyToHalfEdge.get(startEdgeKey.split('-').join('-')); 
        if (startHeIdx === undefined) {
             const parts = startEdgeKey.split('-');
             startHeIdx = graph.edgeKeyToHalfEdge.get(`${parts[1]}-${parts[0]}`);
        }
        if (startHeIdx === undefined) return [startEdgeKey];

        const loop = new Set<string>();
        loop.add(graph.halfEdges[startHeIdx].edgeKey);

        MeshTopologyUtils.walkEdgeLoop(graph, startHeIdx, loop);
        
        const pairIdx = graph.halfEdges[startHeIdx].pair;
        if (pairIdx !== -1) {
            MeshTopologyUtils.walkEdgeLoop(graph, pairIdx, loop);
        }

        return Array.from(loop);
    },

    walkEdgeLoop: (graph: MeshTopology, startHeIdx: number, result: Set<string>) => {
        let currentHeIdx = startHeIdx;
        while (true) {
            const he = graph.halfEdges[currentHeIdx];
            const faceEdge = graph.faces[he.face].edge;
            let edgeCount = 0;
            let iter = faceEdge;
            do { edgeCount++; iter = graph.halfEdges[iter].next; } while(iter !== faceEdge);

            if (edgeCount !== 4) break; 

            const nextAcrossIdx = graph.halfEdges[graph.halfEdges[he.next].next].id;
            const nextKey = graph.halfEdges[nextAcrossIdx].edgeKey;
            if (result.has(nextKey)) break;
            result.add(nextKey);

            const pairIdx = graph.halfEdges[nextAcrossIdx].pair;
            if (pairIdx === -1) break;
            
            currentHeIdx = pairIdx;
        }
    },

    getEdgeRing: (mesh: LogicalMesh, startEdgeKey: string): string[] => {
        if (!mesh.graph) return [startEdgeKey];
        const graph = mesh.graph;
        
        const parts = startEdgeKey.split('-');
        let startHeIdx = graph.edgeKeyToHalfEdge.get(`${parts[0]}-${parts[1]}`);
        if (startHeIdx === undefined) startHeIdx = graph.edgeKeyToHalfEdge.get(`${parts[1]}-${parts[0]}`);
        if (startHeIdx === undefined) return [startEdgeKey];

        const ring = new Set<string>();
        ring.add(graph.halfEdges[startHeIdx].edgeKey);

        MeshTopologyUtils.walkEdgeRing(graph, startHeIdx, ring);
        const pair = graph.halfEdges[startHeIdx].pair;
        if (pair !== -1) MeshTopologyUtils.walkEdgeRing(graph, pair, ring);

        return Array.from(ring);
    },

    walkEdgeRing: (graph: MeshTopology, startHeIdx: number, result: Set<string>) => {
        let currentHeIdx = startHeIdx;
        while(true) {
            const he = graph.halfEdges[currentHeIdx];
            const nextHe = graph.halfEdges[he.next];
            const nextPair = nextHe.pair;
            if (nextPair === -1) break; 
            
            const parallelHeIdx = graph.halfEdges[nextPair].next;
            const faceEdge = graph.faces[graph.halfEdges[parallelHeIdx].face].edge;
            let edgeCount = 0; let iter = faceEdge;
            do { edgeCount++; iter = graph.halfEdges[iter].next; } while(iter !== faceEdge);
            if (edgeCount !== 4) break;

            const nextKey = graph.halfEdges[parallelHeIdx].edgeKey;
            if (result.has(nextKey)) break;
            result.add(nextKey);
            
            currentHeIdx = parallelHeIdx;
        }
    },

    getVertexLoop: (mesh: LogicalMesh, startVertex: number): number[] => {
        if (!mesh.graph) return [startVertex];
        const connected = new Set<number>();
        const startHe = mesh.graph.vertices[startVertex].edge;
        if (startHe === -1) return [startVertex];

        let curr = startHe;
        let safe = 0;
        do {
            const he = mesh.graph.halfEdges[curr];
            connected.add(he.vertex);
            const pair = he.pair;
            if (pair === -1) break; 
            curr = mesh.graph.halfEdges[pair].next;
            safe++;
        } while (curr !== startHe && safe < 20);
        
        return Array.from(connected);
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
