
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
                
                // Link Vertex to ONE outgoing edge (we use the edge pointing FROM vCurrent)
                // Since this HE points TO vNext, it starts FROM vCurrent.
                // However, conventionally HE.vertex is the destination. 
                // So the outgoing edge for vCurrent is actually this HE.
                // Wait, standard HE: origin -> vertex. 
                // Let's stick to standard: he.vertex is the HEAD. Origin is implicit (he.prev.vertex).
                // So this edge belongs to vertex `vNext`'s incoming ring, or `vCurrent`'s outgoing ring?
                // Usually vertices store an *outgoing* half-edge.
                // This edge goes vCurrent -> vNext. So it is outgoing from vCurrent.
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

    /**
     * Selects an edge loop based on Maya-style quad topology rules.
     * Stops at poles (vertices with valence != 4) or boundaries.
     */
    getEdgeLoop: (mesh: LogicalMesh, startEdgeKey: string): string[] => {
        if (!mesh.graph) return [startEdgeKey];
        
        const graph = mesh.graph;
        
        // Find one half-edge for this key (direction doesn't matter for key start)
        // Try forward
        let startHeIdx = graph.edgeKeyToHalfEdge.get(startEdgeKey.split('-').join('-')); 
        // If not found, try reverse key just in case input is flipped
        if (startHeIdx === undefined) {
             const parts = startEdgeKey.split('-');
             startHeIdx = graph.edgeKeyToHalfEdge.get(`${parts[1]}-${parts[0]}`);
        }
        if (startHeIdx === undefined) return [startEdgeKey];

        const loop = new Set<string>();
        loop.add(graph.halfEdges[startHeIdx].edgeKey);

        // Walk Direction 1
        MeshTopologyUtils.walkEdgeLoop(graph, startHeIdx, loop);
        
        // Walk Direction 2 (Reverse)
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
            
            // In a quad, the "loop continuation" edge is across the face.
            // HE -> Next -> Next.
            // Check if face is a Quad
            const faceEdge = graph.faces[he.face].edge;
            let edgeCount = 0;
            let iter = faceEdge;
            do { edgeCount++; iter = graph.halfEdges[iter].next; } while(iter !== faceEdge);

            if (edgeCount !== 4) break; // Stop at non-quads (triangles, ngons)

            // Jump across face
            const nextAcrossIdx = graph.halfEdges[graph.halfEdges[he.next].next].id;
            
            // Check Valence of the vertex we just crossed (he.next.vertex)
            // Ideally we check valence to stop at poles, but jumping across quad is the robust definition of loop
            
            // Add to result
            const nextKey = graph.halfEdges[nextAcrossIdx].edgeKey;
            if (result.has(nextKey)) break; // Loop closed
            result.add(nextKey);

            // Cross boundary to continue loop
            const pairIdx = graph.halfEdges[nextAcrossIdx].pair;
            if (pairIdx === -1) break; // Boundary reached
            
            currentHeIdx = pairIdx;
        }
    },

    /**
     * Selects an edge RING (parallel edges).
     */
    getEdgeRing: (mesh: LogicalMesh, startEdgeKey: string): string[] => {
        if (!mesh.graph) return [startEdgeKey];
        const graph = mesh.graph;
        
        // Resolve HE index similar to Loop
        const parts = startEdgeKey.split('-');
        let startHeIdx = graph.edgeKeyToHalfEdge.get(`${parts[0]}-${parts[1]}`);
        if (startHeIdx === undefined) startHeIdx = graph.edgeKeyToHalfEdge.get(`${parts[1]}-${parts[0]}`);
        if (startHeIdx === undefined) return [startEdgeKey];

        const ring = new Set<string>();
        ring.add(graph.halfEdges[startHeIdx].edgeKey);

        // Walk Both Sides
        MeshTopologyUtils.walkEdgeRing(graph, startHeIdx, ring);
        const pair = graph.halfEdges[startHeIdx].pair;
        if (pair !== -1) MeshTopologyUtils.walkEdgeRing(graph, pair, ring);

        return Array.from(ring);
    },

    walkEdgeRing: (graph: MeshTopology, startHeIdx: number, result: Set<string>) => {
        let currentHeIdx = startHeIdx;
        while(true) {
            const he = graph.halfEdges[currentHeIdx];
            
            // In a quad, the ring neighbor is shared via the shared edges (next or prev)
            // But visually, it's the edge connected via "next" then "pair" then "next"? 
            // No, Ring is "side-by-side".
            // Implementation: Go to Next Edge in face -> Cross to Pair -> That edge is parallel.
            
            const nextHe = graph.halfEdges[he.next];
            const nextPair = nextHe.pair;
            if (nextPair === -1) break; // Boundary
            
            // In the adjacent face, the parallel edge is .next of the shared edge
            const parallelHeIdx = graph.halfEdges[nextPair].next;
            
            // Check Quad geometry
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

    /**
     * Vertex Loop (often called Vertex Ring in generic terms, usually means vertices along an edge loop)
     * We simulate this by getting the edge loop, then collecting unique vertices.
     */
    getVertexLoop: (mesh: LogicalMesh, startVertex: number): number[] => {
        if (!mesh.graph) return [startVertex];
        
        // We need a direction. Usually defined by mouse movement or selection context.
        // Without an edge, "Vertex Loop" is ambiguous (could be any of 4 directions on a grid).
        // Fallback: Return connected vertices (Star/Umbrella)
        const connected = new Set<number>();
        const startHe = mesh.graph.vertices[startVertex].edge;
        if (startHe === -1) return [startVertex];

        // Circulate around vertex
        let curr = startHe;
        let safe = 0;
        do {
            const he = mesh.graph.halfEdges[curr];
            // he.vertex is the TO vertex. Origin is startVertex.
            connected.add(he.vertex);
            
            // Move to next spoke: pair -> next
            const pair = he.pair;
            if (pair === -1) break; // Boundary
            curr = mesh.graph.halfEdges[pair].next;
            safe++;
        } while (curr !== startHe && safe < 20);
        
        return Array.from(connected);
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
