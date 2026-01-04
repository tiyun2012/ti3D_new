
import { LogicalMesh, Vector3, MeshTopology, HalfEdge } from '../types';
/* Ray is exported from ./math, not ../types */
import { Vec3Utils, RayUtils, AABB, Ray, AABBUtils } from './math';

export interface MeshPickingResult {
    t: number;
    vertexId: number;
    edgeId: [number, number];
    faceId: number;
    worldPos: Vector3;
}

// Optimized BVH Tree Node
interface BVHNode {
    aabb: AABB;
    left?: BVHNode;
    right?: BVHNode;
    faceIndices?: number[]; // Only exists on leaves
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
     * Builds a recursive AABB Tree (BVH) for O(log N) raycasting.
     */
    buildBVH: (mesh: LogicalMesh, vertices: Float32Array): BVHNode => {
        const indices = mesh.faces.map((_, i) => i);
        
        // Pre-calculate face centroids and bounds to avoid re-computing during build
        const faceData = indices.map(i => {
            const face = mesh.faces[i];
            const bounds = AABBUtils.create();
            const center = { x: 0, y: 0, z: 0 };
            
            face.forEach(vIdx => {
                const x = vertices[vIdx*3], y = vertices[vIdx*3+1], z = vertices[vIdx*3+2];
                AABBUtils.expandPoint(bounds, {x, y, z});
                center.x += x; center.y += y; center.z += z;
            });
            center.x /= face.length; center.y /= face.length; center.z /= face.length;
            return { i, bounds, center };
        });

        const buildRecursive = (items: typeof faceData): BVHNode => {
            const node: BVHNode = { aabb: AABBUtils.create() };
            
            // Calculate Node AABB
            items.forEach(item => AABBUtils.union(node.aabb, node.aabb, item.bounds));

            // Leaf Condition (Max 8 faces per leaf)
            if (items.length <= 8) {
                node.faceIndices = items.map(item => item.i);
                return node;
            }

            // Split Axis (Extent)
            const extent = {
                x: node.aabb.max.x - node.aabb.min.x,
                y: node.aabb.max.y - node.aabb.min.y,
                z: node.aabb.max.z - node.aabb.min.z
            };
            
            const axis = (extent.x > extent.y && extent.x > extent.z) ? 'x' 
                       : (extent.y > extent.z) ? 'y' : 'z';
            
            // Midpoint Split
            const mid = (node.aabb.min[axis] + node.aabb.max[axis]) * 0.5;
            
            const leftItems: typeof faceData = [];
            const rightItems: typeof faceData = [];

            items.forEach(item => {
                if (item.center[axis] < mid) leftItems.push(item);
                else rightItems.push(item);
            });

            // Handle degenerate splits
            if (leftItems.length === 0 || rightItems.length === 0) {
                node.faceIndices = items.map(item => item.i);
                return node;
            }

            node.left = buildRecursive(leftItems);
            node.right = buildRecursive(rightItems);
            return node;
        };

        return buildRecursive(faceData);
    },

    /**
     * Accelerated Raycast using BVH Tree.
     */
    raycastMesh: (mesh: LogicalMesh, vertices: Float32Array, ray: Ray, tolerance: number = 0.05): MeshPickingResult | null => {
        let bestResult: MeshPickingResult | null = null;
        let minT = Infinity;

        // Force rebuild if vertex count mismatch (topology changed)
        // Check random sample vertex or length match?
        // Note: LogicalMesh doesn't store vertex count directly, but it relies on 'vertices' array being compatible.
        // If vertices array length changed, rebuild BVH.
        // We can't store previous length on LogicalMesh easily in this static function without mutation.
        // But the Engine invalidates bvh explicitly. Here we just build if missing.
        
        if (!mesh.bvh) mesh.bvh = MeshTopologyUtils.buildBVH(mesh, vertices);
        const root = mesh.bvh as BVHNode;

        const traverse = (node: BVHNode) => {
            // 1. Check AABB overlap (Fast rejection)
            if (RayUtils.intersectAABB(ray, node.aabb) === null) return;

            // 2. Leaf Node: Check Triangles
            if (node.faceIndices) {
                for (const fIdx of node.faceIndices) {
                    if (fIdx >= mesh.faces.length) continue; // Safety check
                    const face = mesh.faces[fIdx];
                    
                    // Simple Fan Triangulation for intersection
                    for (let i = 1; i < face.length - 1; i++) {
                        const v0Idx = face[0];
                        const v1Idx = face[i];
                        const v2Idx = face[i+1];
                        
                        // Safety check for indices bounds
                        if (v0Idx*3 >= vertices.length || v1Idx*3 >= vertices.length || v2Idx*3 >= vertices.length) continue;

                        const v0 = { x: vertices[v0Idx*3], y: vertices[v0Idx*3+1], z: vertices[v0Idx*3+2] };
                        const v1 = { x: vertices[v1Idx*3], y: vertices[v1Idx*3+1], z: vertices[v1Idx*3+2] };
                        const v2 = { x: vertices[v2Idx*3], y: vertices[v2Idx*3+1], z: vertices[v2Idx*3+2] };

                        const t = RayUtils.intersectTriangle(ray, v0, v1, v2);
                        
                        if (t !== null && t < minT) {
                            minT = t;
                            const hitPos = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, t, {x:0,y:0,z:0}), {x:0,y:0,z:0});
                            
                            // Find closest component on this face
                            let closestV = -1;
                            let minDistV = Infinity; // Find absolute closest first
                            
                            face.forEach(vIdx => {
                                if (vIdx*3 < vertices.length) {
                                    const vp = { x: vertices[vIdx*3], y: vertices[vIdx*3+1], z: vertices[vIdx*3+2] };
                                    const d = Vec3Utils.distanceSquared(hitPos, vp);
                                    if (d < minDistV) { minDistV = d; closestV = vIdx; }
                                }
                            });

                            // Determine Edge
                            let closestEdge: [number, number] = [face[0], face[1]];
                            let minDistE = Infinity;
                            for(let k=0; k<face.length; k++) {
                                const vA = face[k]; const vB = face[(k+1)%face.length];
                                if (vA*3 < vertices.length && vB*3 < vertices.length) {
                                    const pA = { x: vertices[vA*3], y: vertices[vA*3+1], z: vertices[vA*3+2] };
                                    const pB = { x: vertices[vB*3], y: vertices[vB*3+1], z: vertices[vB*3+2] };
                                    const d = RayUtils.distRaySegment(ray, pA, pB);
                                    if (d < minDistE) { minDistE = d; closestEdge = [vA, vB]; }
                                }
                            }
                            
                            bestResult = { t, faceId: fIdx, vertexId: closestV, edgeId: closestEdge, worldPos: hitPos };
                        }
                    }
                }
                return;
            }

            // 3. Branch Node: Recurse
            if (node.left) traverse(node.left);
            if (node.right) traverse(node.right);
        };

        traverse(root);
        return bestResult;
    },

    /**
     * Efficiently find the closest vertex using the BVH raycast result.
     * MUCH faster than iterating all vertices.
     */
    findNearestVertexOnRay: (mesh: LogicalMesh, vertices: Float32Array, ray: Ray, threshold: number): number | null => {
        // reuse the raycast logic to get the closest face first
        const hit = MeshTopologyUtils.raycastMesh(mesh, vertices, ray);
        
        if (hit) {
            // Check if the closest vertex on that face is within threshold
            const vIdx = hit.vertexId;
            const px = vertices[vIdx*3], py = vertices[vIdx*3+1], pz = vertices[vIdx*3+2];
            
            // Project vertex to ray to get true distance to ray line
            const vPos = {x: px, y: py, z: pz};
            const rayToV = Vec3Utils.subtract(vPos, ray.origin, {x:0,y:0,z:0});
            const t = Vec3Utils.dot(rayToV, ray.direction);
            const closestPointOnRay = Vec3Utils.add(ray.origin, Vec3Utils.scale(ray.direction, t, {x:0,y:0,z:0}), {x:0,y:0,z:0});
            const dist = Vec3Utils.distance(vPos, closestPointOnRay);

            // Note: Threshold here is in World Units.
            // Screen space conversion should happen in Engine before calling this or we use a generous world tolerance.
            if (dist < threshold) return vIdx;
        }
        return null;
    },

    /**
     * Brush Selection: Finds all vertices within a 3D sphere using the BVH.
     */
    getVerticesInWorldSphere: (mesh: LogicalMesh, vertices: Float32Array, center: Vector3, radius: number): number[] => {
        if (!mesh.bvh) mesh.bvh = MeshTopologyUtils.buildBVH(mesh, vertices);
        const root = mesh.bvh as BVHNode;
        const results = new Set<number>();
        const radiusSq = radius * radius;

        // Sphere AABB for fast rejection
        const sphereBox = AABBUtils.create();
        sphereBox.min = { x: center.x - radius, y: center.y - radius, z: center.z - radius };
        sphereBox.max = { x: center.x + radius, y: center.y + radius, z: center.z + radius };

        const traverse = (node: BVHNode) => {
            if (!AABBUtils.intersects(node.aabb, sphereBox)) return;

            if (node.faceIndices) {
                for (const fIdx of node.faceIndices) {
                    const face = mesh.faces[fIdx];
                    for (const vIdx of face) {
                        if (results.has(vIdx)) continue;
                        if (vIdx*3 >= vertices.length) continue;
                        const vx = vertices[vIdx*3], vy = vertices[vIdx*3+1], vz = vertices[vIdx*3+2];
                        const distSq = (vx-center.x)**2 + (vy-center.y)**2 + (vz-center.z)**2;
                        if (distSq <= radiusSq) {
                            results.add(vIdx);
                        }
                    }
                }
                return;
            }

            if (node.left) traverse(node.left);
            if (node.right) traverse(node.right);
        };

        traverse(root);
        return Array.from(results);
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
