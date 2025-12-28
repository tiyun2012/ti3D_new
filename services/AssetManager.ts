
import { StaticMeshAsset, SkeletalMeshAsset, MaterialAsset, PhysicsMaterialAsset, ScriptAsset, RigAsset, TextureAsset, GraphNode, GraphConnection, Asset, LogicalMesh, FolderAsset } from '../types';
import { MaterialTemplate, MATERIAL_TEMPLATES } from './MaterialTemplates';
import { MESH_TYPES } from './constants';
import { engineInstance } from './engine';

export interface RigTemplate {
    name: string;
    description: string;
    nodes: GraphNode[];
    connections: GraphConnection[];
}

export const RIG_TEMPLATES: RigTemplate[] = [
    {
        name: 'Locomotion IK Logic',
        description: 'Basic two-bone IK setup for leg movement.',
        nodes: [
            { id: 'time', type: 'Time', position: { x: 50, y: 50 } },
            { id: 'speed', type: 'Float', position: { x: 50, y: 150 }, data: { value: '3.0' } },
            { id: 'mul_t', type: 'Multiply', position: { x: 250, y: 100 } },
            { id: 'sin', type: 'Sine', position: { x: 400, y: 100 } },
            { id: 'zero', type: 'Float', position: { x: 400, y: 200 }, data: { value: '0.0' } },
            { id: 'gt', type: 'GreaterThan', position: { x: 550, y: 150 } },
            { id: 'in', type: 'RigInput', position: { x: 50, y: 400 } },
            { id: 'branch', type: 'Branch', position: { x: 750, y: 300 } },
            { id: 'target', type: 'Vec3', position: { x: 750, y: 500 }, data: { x: '0.2', y: '0.5', z: '0.0' } },
            { id: 'ik', type: 'TwoBoneIK', position: { x: 950, y: 450 }, data: { root: 'Thigh_L', mid: 'Calf_L', eff: 'Foot_L' } },
            { id: 'out', type: 'RigOutput', position: { x: 1200, y: 350 } }
        ],
        connections: [
            { id: 'l1', fromNode: 'time', fromPin: 'out', toNode: 'mul_t', toPin: 'a' },
            { id: 'l2', fromNode: 'speed', fromPin: 'out', toNode: 'mul_t', toPin: 'b' },
            { id: 'l3', fromNode: 'mul_t', fromPin: 'out', toNode: 'sin', toPin: 'in' },
            { id: 'l4', fromNode: 'sin', fromPin: 'out', toNode: 'gt', toPin: 'a' },
            { id: 'l5', fromNode: 'zero', fromPin: 'out', toNode: 'gt', toPin: 'b' },
            { id: 'f1', fromNode: 'gt', fromPin: 'out', toNode: 'branch', toPin: 'condition' },
            { id: 'f2', fromNode: 'in', fromPin: 'pose', toNode: 'branch', toPin: 'false' },
            { id: 'f3', fromNode: 'in', fromPin: 'pose', toNode: 'ik', toPin: 'pose' },
            { id: 'f4', fromNode: 'target', fromPin: 'out', toNode: 'ik', toPin: 'target' },
            { id: 'f5', fromNode: 'ik', fromPin: 'outPose', toNode: 'branch', toPin: 'true' },
            { id: 'f6', fromNode: 'branch', fromPin: 'out', toNode: 'out', toPin: 'pose' }
        ]
    }
];

class AssetManagerService {
    assets = new Map<string, Asset>();
    
    meshIntToUuid = new Map<number, string>();
    meshUuidToInt = new Map<string, number>();
    matIntToUuid = new Map<number, string>();
    matUuidToInt = new Map<string, number>();
    physMatIntToUuid = new Map<number, string>();
    physMatUuidToInt = new Map<string, number>();
    rigIntToUuid = new Map<number, string>();
    rigUuidToInt = new Map<string, number>();

    private nextMeshIntId = 100; 
    private nextMatIntId = 1; 
    private nextPhysMatIntId = 1;
    private nextRigIntId = 1;
    private nextTextureLayerId = 4; 

    constructor() {
        this.registerDefaultAssets();
        this.createMaterial('Standard', MATERIAL_TEMPLATES[0]);
        this.createDefaultPhysicsMaterials();
        this.createScript('New Visual Script');
        this.createRig('Locomotion IK Logic', RIG_TEMPLATES[0]);
    }

    private createDefaultPhysicsMaterials() {
        this.createPhysicsMaterial('Concrete', { staticFriction: 0.8, dynamicFriction: 0.7, bounciness: 0.1, density: 2.4 });
        this.createPhysicsMaterial('Rubber', { staticFriction: 0.9, dynamicFriction: 0.8, bounciness: 0.8, density: 1.1 });
        this.createPhysicsMaterial('Ice', { staticFriction: 0.05, dynamicFriction: 0.03, bounciness: 0.1, density: 0.9 });
    }

    updatePhysicsMaterial(id: string, partialData: Partial<PhysicsMaterialAsset['data']>) {
        const asset = this.getAsset(id);
        if (asset && asset.type === 'PHYSICS_MATERIAL') {
            asset.data = { ...asset.data, ...partialData };
        }
    }

    renameAsset(id: string, newName: string) {
        const asset = this.getAsset(id);
        if (asset && !asset.isProtected) {
            asset.name = newName;
        }
    }

    createFolder(name: string, path: string): FolderAsset {
        const id = crypto.randomUUID();
        const folder: FolderAsset = {
            id, name, type: 'FOLDER', path
        };
        this.registerAsset(folder);
        return folder;
    }

    saveMaterial(id: string, nodes: GraphNode[], connections: GraphConnection[], glsl: string) {
        const asset = this.getAsset(id);
        if (asset && asset.type === 'MATERIAL') {
            asset.data.nodes = JSON.parse(JSON.stringify(nodes));
            asset.data.connections = JSON.parse(JSON.stringify(connections));
            asset.data.glsl = glsl;
        }
    }

    saveScript(id: string, nodes: GraphNode[], connections: GraphConnection[]) {
        const asset = this.getAsset(id);
        if (asset && (asset.type === 'SCRIPT' || asset.type === 'RIG')) {
            asset.data.nodes = JSON.parse(JSON.stringify(nodes));
            asset.data.connections = JSON.parse(JSON.stringify(connections));
        }
    }

    duplicateAsset(id: string): Asset | null {
        const original = this.getAsset(id);
        if (!original) return null;
        const copy = JSON.parse(JSON.stringify(original));
        copy.id = crypto.randomUUID();
        copy.name = `${original.name} (Copy)`;
        copy.isProtected = false; 
        this.registerAsset(copy);
        return copy;
    }

    deleteAsset(id: string) {
        const asset = this.assets.get(id);
        if (!asset || asset.isProtected) return;

        this.assets.delete(id);
        
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            const intId = this.meshUuidToInt.get(id);
            if (intId !== undefined) {
                this.meshUuidToInt.delete(id);
                this.meshIntToUuid.delete(intId);
            }
        } else if (asset.type === 'MATERIAL') {
            const intId = this.matUuidToInt.get(id);
            if (intId !== undefined) {
                this.matUuidToInt.delete(id);
                this.matIntToUuid.delete(intId);
            }
        } else if (asset.type === 'PHYSICS_MATERIAL') {
            const intId = this.physMatUuidToInt.get(id);
            if (intId !== undefined) {
                this.physMatUuidToInt.delete(id);
                this.physMatIntToUuid.delete(intId);
            }
        } else if (asset.type === 'RIG') {
            const intId = this.rigUuidToInt.get(id);
            if (intId !== undefined) {
                this.rigUuidToInt.delete(id);
                this.rigIntToUuid.delete(intId);
            }
        }
    }

    registerAsset(asset: Asset, forcedIntId?: number): number {
        // Ensure path defaults to /Content if missing (migration)
        if (!asset.path) asset.path = '/Content';
        
        this.assets.set(asset.id, asset);
        
        if (asset.type === 'MESH' || asset.type === 'SKELETAL_MESH') {
            if (this.meshUuidToInt.has(asset.id)) return this.meshUuidToInt.get(asset.id)!;
            const intId = forcedIntId || this.nextMeshIntId++;
            this.meshIntToUuid.set(intId, asset.id);
            this.meshUuidToInt.set(asset.id, intId);
            return intId;
        } else if (asset.type === 'MATERIAL') {
            if (this.matUuidToInt.has(asset.id)) return this.matUuidToInt.get(asset.id)!;
            const intId = this.nextMatIntId++;
            this.matIntToUuid.set(intId, asset.id);
            this.matUuidToInt.set(asset.id, intId);
            return intId;
        } else if (asset.type === 'PHYSICS_MATERIAL') {
            if (this.physMatUuidToInt.has(asset.id)) return this.physMatUuidToInt.get(asset.id)!;
            const intId = this.nextPhysMatIntId++;
            this.physMatIntToUuid.set(intId, asset.id);
            this.physMatUuidToInt.set(asset.id, intId);
            return intId;
        } else if (asset.type === 'RIG') {
            if (this.rigUuidToInt.has(asset.id)) return this.rigUuidToInt.get(asset.id)!;
            const intId = this.nextRigIntId++;
            this.rigIntToUuid.set(intId, asset.id);
            this.rigUuidToInt.set(asset.id, intId);
            return intId;
        }
        return 0;
    }

    getAsset(id: string) {
        return this.assets.get(id);
    }

    getMeshID(uuid: string): number { return this.meshUuidToInt.get(uuid) || 0; }
    getMaterialID(uuid: string): number { return this.matUuidToInt.get(uuid) || 0; }
    getMaterialUUID(intId: number): string | undefined { return this.matIntToUuid.get(intId); } 
    getPhysicsMaterialID(uuid: string): number { return this.physMatUuidToInt.get(uuid) || 0; }
    getPhysicsMaterialUUID(intId: number): string | undefined { return this.physMatIntToUuid.get(intId); }
    getRigID(uuid: string): number { return this.rigUuidToInt.get(uuid) || 0; }
    getRigUUID(intId: number): string | undefined { return this.rigIntToUuid.get(intId); }

    getAllAssets() {
        return Array.from(this.assets.values());
    }
    
    getAssetsByType(type: Asset['type']) {
        return Array.from(this.assets.values()).filter(a => a.type === type);
    }

    createTexture(name: string, source: string): TextureAsset {
        const id = crypto.randomUUID();
        const layerIndex = this.nextTextureLayerId;
        this.nextTextureLayerId = 4 + ((this.nextTextureLayerId - 3) % 12); 
        const asset: TextureAsset = { id, name, type: 'TEXTURE', source, layerIndex, path: '/Content/Textures' };
        this.registerAsset(asset);
        const img = new Image();
        img.onload = () => { if (engineInstance?.meshSystem) engineInstance.meshSystem.uploadTexture(asset.layerIndex, img); };
        img.src = asset.source;
        return asset;
    }

    createMaterial(name: string, template?: MaterialTemplate, path: string = '/Content/Materials'): MaterialAsset {
        const id = crypto.randomUUID();
        const base = template || MATERIAL_TEMPLATES[0];
        const mat: MaterialAsset = {
            id, name, type: 'MATERIAL', path,
            data: { nodes: JSON.parse(JSON.stringify(base.nodes)), connections: JSON.parse(JSON.stringify(base.connections)), glsl: '' }
        };
        this.registerAsset(mat);
        return mat;
    }

    createPhysicsMaterial(name: string, data?: PhysicsMaterialAsset['data'], path: string = '/Content/Physics'): PhysicsMaterialAsset {
        const id = crypto.randomUUID();
        const asset: PhysicsMaterialAsset = { id, name, type: 'PHYSICS_MATERIAL', path, data: data || { staticFriction: 0.6, dynamicFriction: 0.6, bounciness: 0.0, density: 1.0 } };
        this.registerAsset(asset);
        return asset;
    }

    createScript(name: string, path: string = '/Content/Scripts'): ScriptAsset {
        const id = crypto.randomUUID();
        const nodes: GraphNode[] = [
            { id: 'time', type: 'Time', position: { x: 50, y: 150 } },
            { id: 'sin', type: 'Sine', position: { x: 250, y: 150 } },
            { id: 'mul', type: 'Multiply', position: { x: 450, y: 150 } },
            { id: 'val', type: 'Float', position: { x: 250, y: 250 }, data: { value: '2.0' } }
        ];
        const connections: GraphConnection[] = [
            { id: 'c1', fromNode: 'time', fromPin: 'out', toNode: 'sin', toPin: 'in' },
            { id: 'c2', fromNode: 'sin', fromPin: 'out', toNode: 'mul', toPin: 'a' },
            { id: 'c3', fromNode: 'val', fromPin: 'out', toNode: 'mul', toPin: 'b' }
        ];
        const asset: ScriptAsset = { id, name, type: 'SCRIPT', path, data: { nodes, connections } };
        this.registerAsset(asset);
        return asset;
    }

    createRig(name: string, template?: RigTemplate, path: string = '/Content/Rigs'): RigAsset {
        const id = crypto.randomUUID();
        const base = template || RIG_TEMPLATES[0];
        const asset: RigAsset = { id, name, type: 'RIG', path, data: { nodes: JSON.parse(JSON.stringify(base.nodes)), connections: JSON.parse(JSON.stringify(base.connections)) } };
        this.registerAsset(asset);
        return asset;
    }

    async importFile(fileName: string, content: string | ArrayBuffer, type: 'MESH' | 'SKELETAL_MESH', importScale: number = 1.0): Promise<Asset> {
        const id = crypto.randomUUID();
        const name = fileName.split('.')[0] || 'Imported_Mesh';
        let geometryData: any = { v: [], n: [], u: [], idx: [], faces: [], triToFace: [] };
        let skeletonData: any = null;

        const ext = fileName.toLowerCase();

        if (ext.endsWith('.obj')) {
            geometryData = this.parseOBJ(typeof content === 'string' ? content : new TextDecoder().decode(content), importScale);
        } else if (ext.endsWith('.fbx')) {
            const fbxData = await this.parseFBX(content, importScale);
            geometryData = fbxData.geometry;
            if (type === 'SKELETAL_MESH') skeletonData = fbxData.skeleton;
        } else {
            console.warn("Unsupported format. Using fallback cylinder.");
            geometryData = this.generateCylinder(24);
        }

        const v2f = new Map<number, number[]>();
        geometryData.faces.forEach((f: number[], i: number) => {
            f.forEach(vIdx => {
                if(!v2f.has(vIdx)) v2f.set(vIdx, []);
                v2f.get(vIdx)!.push(i);
            });
        });

        const topology: LogicalMesh = {
            faces: geometryData.faces,
            triangleToFaceIndex: new Int32Array(geometryData.triToFace),
            vertexToFaces: v2f
        };

        // Create default skin weights if none exist or if it's a static mesh being imported as skeletal
        const vertexCount = geometryData.v.length / 3;
        if (!geometryData.jointIndices || geometryData.jointIndices.length === 0) {
            geometryData.jointIndices = new Float32Array(vertexCount * 4).fill(0);
            geometryData.jointWeights = new Float32Array(vertexCount * 4).fill(0);
            for(let i=0; i<vertexCount; i++) geometryData.jointWeights[i*4] = 1.0; // Weight 1.0 to root (0)
        }

        const assetBase = {
            id, name, type,
            path: '/Content/Meshes',
            geometry: {
                vertices: new Float32Array(geometryData.v),
                normals: new Float32Array(geometryData.n),
                uvs: new Float32Array(geometryData.u),
                indices: new Uint16Array(geometryData.idx)
            },
            topology
        };

        if (type === 'SKELETAL_MESH') {
             const skelAsset: SkeletalMeshAsset = {
                 ...assetBase,
                 type: 'SKELETAL_MESH',
                 geometry: {
                     ...assetBase.geometry,
                     jointIndices: new Float32Array(geometryData.jointIndices),
                     jointWeights: new Float32Array(geometryData.jointWeights)
                 },
                 skeleton: skeletonData || { bones: [{ name: 'Root', parentIndex: -1, bindPose: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]) }] }
             };
             this.registerAsset(skelAsset);
             return skelAsset;
        }

        const staticAsset: StaticMeshAsset = { ...assetBase, type: 'MESH' };
        this.registerAsset(staticAsset);
        return staticAsset;
    }

    private parseOBJ(text: string, scale: number) {
        const positions: number[][] = [];
        const normals: number[][] = [];
        const uvs: number[][] = [];
        const finalV: number[] = [];
        const finalN: number[] = [];
        const finalU: number[] = [];
        const finalIdx: number[] = [];
        const logicalFaces: number[][] = [];
        const triToFace: number[] = [];
        const cache = new Map<string, number>();
        let nextIdx = 0;
        
        const lines = text.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#') || line.length === 0) continue;
            const parts = line.split(/\s+/);
            const type = parts[0];
            if (type === 'v') positions.push([parseFloat(parts[1]) * scale, parseFloat(parts[2]) * scale, parseFloat(parts[3]) * scale]);
            else if (type === 'vn') normals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
            else if (type === 'vt') uvs.push([parseFloat(parts[1]), parseFloat(parts[2])]);
            else if (type === 'f') {
                const poly = parts.slice(1);
                const polyVertIndices = [];
                
                const resolveIndex = (indexStr: string, arrayLength: number) => {
                    if (!indexStr) return 0;
                    const idx = parseInt(indexStr);
                    return idx < 0 ? arrayLength + idx : idx - 1;
                };

                for (const vertStr of poly) {
                    if (cache.has(vertStr)) {
                        polyVertIndices.push(cache.get(vertStr)!);
                    } else {
                        const subParts = vertStr.split('/');
                        const vI = resolveIndex(subParts[0], positions.length);
                        const tI = subParts.length > 1 ? resolveIndex(subParts[1], uvs.length) : -1;
                        const nI = subParts.length > 2 ? resolveIndex(subParts[2], normals.length) : -1;
                        const pos = positions[vI] || [0,0,0];
                        const uv = (tI !== -1 && uvs[tI]) ? uvs[tI] : [0,0];
                        const norm = (nI !== -1 && normals[nI]) ? normals[nI] : [0,1,0];
                        finalV.push(...pos); finalN.push(...norm); finalU.push(...uv);
                        cache.set(vertStr, nextIdx);
                        polyVertIndices.push(nextIdx++);
                    }
                }

                const faceIdx = logicalFaces.length;
                logicalFaces.push(polyVertIndices);
                for (let i = 1; i < polyVertIndices.length - 1; i++) {
                    finalIdx.push(polyVertIndices[0], polyVertIndices[i], polyVertIndices[i+1]);
                    triToFace.push(faceIdx);
                }
            }
        }
        this.generateMissingNormals(finalV, finalN, finalIdx);
        return { v: finalV, n: finalN, u: finalU, idx: finalIdx, faces: logicalFaces, triToFace };
    }

    private async parseFBX(content: string | ArrayBuffer, importScale: number) {
        if (content instanceof ArrayBuffer) {
            const header = new Uint8Array(content.slice(0, 18));
            const headerStr = new TextDecoder().decode(header);
            if (headerStr.includes("Kaydara FBX Binary")) {
                return await this.parseFBXBinary(content, importScale);
            }
            // Log for debugging corruption
            console.warn("FBX Header Mismatch:", headerStr, Array.from(header).map(b => b.toString(16)).join(' '));
            return this.parseFBXASCII(new TextDecoder().decode(content), importScale);
        }
        return this.parseFBXASCII(content, importScale);
    }

    private async inflate(data: Uint8Array, expectedSize: number): Promise<Uint8Array> {
        // Safe Allocation Check to prevent OOM
        const MAX_ALLOC_SIZE = 512 * 1024 * 1024; // 512 MB Limit
        if (expectedSize > MAX_ALLOC_SIZE) {
            console.error(`FBX Error: Attempted to allocate ${expectedSize} bytes, which exceeds safety limit.`);
            return new Uint8Array(0);
        }

        // Robust inflate that attempts Zlib (default), Gzip, and raw deflate fallback strategies
        const tryInflate = async (format: CompressionFormat, buffer: Uint8Array): Promise<Uint8Array | null> => {
            try {
                const ds = new DecompressionStream(format);
                const writer = ds.writable.getWriter();
                writer.write(buffer);
                writer.close();
                
                const reader = ds.readable.getReader();
                const chunks = [];
                let size = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    size += value.length;
                }
                const res = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                    res.set(chunk, offset);
                    offset += chunk.length;
                }
                return res;
            } catch (e: any) {
                // Squelch individual strategy errors
                return null;
            }
        };

        // Strategy 1: Standard Zlib (RFC 1950)
        let result = await tryInflate('deflate', data);
        if (result && result.byteLength === expectedSize) return result;

        // Strategy 2: Raw Deflate - Data Only (No Header, No Footer)
        if (!result) result = await tryInflate('deflate-raw', data);
        if (result && result.byteLength === expectedSize) return result;

        // Strategy 3: Gzip (Magic 1f 8b) - Used by some custom exporters
        if (!result && data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
             result = await tryInflate('gzip', data);
        }
        if (result && result.byteLength === expectedSize) return result;

        // Strategy 4: Raw Deflate skipping Zlib header (2 bytes)
        // Useful if 'deflate' implementation fails header check but data is raw.
        if (!result && data.length > 2) {
            result = await tryInflate('deflate-raw', data.slice(2));
        }
        if (result && result.byteLength === expectedSize) return result;

        // Strategy 5: Raw Deflate skipping Zlib header (2 bytes) AND Adler32 footer (4 bytes)
        if (!result && data.length > 6) {
             result = await tryInflate('deflate-raw', data.slice(2, data.length - 4));
        }

        // Return best effort result if available
        if (result) return result;

        // Fallback: Return empty buffer to prevent crash, creating a dummy array of correct size if possible and safe
        // If expectedSize is very large, it likely means the header read was garbage, so return small buffer.
        const safeFallbackSize = expectedSize < 1024 * 1024 ? expectedSize : 0;
        const headerHex = Array.from(data.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(' ');
        console.warn(`FBX Decompression Failed. Header: [${headerHex}]. Using fallback buffer size: ${safeFallbackSize}`);
        
        try {
            return new Uint8Array(safeFallbackSize);
        } catch(e) {
            return new Uint8Array(0);
        }
    }

    private async parseFBXBinary(buffer: ArrayBuffer, importScale: number) {
        const view = new DataView(buffer);
        let offset = 27; 
        const version = view.getUint32(23, true);
        
        let finalV: number[] = [];
        let finalIdx: number[] = [];
        let finalUV: number[] = [];
        let finalUVIdx: number[] = [];
        let modelNodes: any[] = [];

        // YIELDING LOGIC
        let lastYield = performance.now();
        const yieldCpu = async () => {
            const now = performance.now();
            if (now - lastYield > 16) { // Yield every 16ms (1 frame)
                await new Promise(r => setTimeout(r, 0));
                lastYield = performance.now();
            }
        };

        const readArrayProp = async (typeCode: string) => {
            if (offset + 12 > buffer.byteLength) return [];
            
            const arrLen = view.getUint32(offset, true);
            const encoding = view.getUint32(offset + 4, true);
            const compLen = view.getUint32(offset + 8, true);
            offset += 12;
            
            // Calculate Expected Size
            const typeSize = (typeCode === 'd' || typeCode === 'l' ? 8 : (typeCode === 'i' || typeCode === 'f' ? 4 : 1));
            // Sanity check for huge arrays
            if (arrLen > 50000000) { // Limit to ~50M elements to prevent crazy allocation
                 console.warn(`FBX: Array length ${arrLen} implies corruption. Skipping.`);
                 return [];
            }
            
            const byteLen = arrLen * typeSize;

            let data: Uint8Array;
            
            try {
                // If encoding is 0 (raw) OR if compressed length matches raw length (flag is wrong), read as raw
                if (encoding === 0 || (encoding === 1 && compLen === byteLen)) {
                    if (offset + byteLen > buffer.byteLength) throw new Error("EOF");
                    data = new Uint8Array(buffer.slice(offset, offset + byteLen));
                    offset += byteLen;
                } else {
                    if (offset + compLen > buffer.byteLength) throw new Error("EOF");
                    // Ensure we slice a COPY of the buffer so the inflate function doesn't interfere with the main buffer
                    const compressed = new Uint8Array(buffer.slice(offset, offset + compLen));
                    data = await this.inflate(compressed, byteLen);
                    offset += compLen;
                }
                
                if (data.byteLength !== byteLen) {
                    // Mismatch, likely failed decompression fallback
                    return [];
                }

                if (typeCode === 'd') return Array.from(new Float64Array(data.buffer, 0, arrLen));
                if (typeCode === 'f') return Array.from(new Float32Array(data.buffer, 0, arrLen));
                if (typeCode === 'i') return Array.from(new Int32Array(data.buffer, 0, arrLen));
                
            } catch (e) {
                console.warn("FBX: Failed to read array property", e);
                // Advance offset blindly if possible to try and recover
                if (encoding === 0) offset += byteLen; else offset += compLen;
                return [];
            }
            return [];
        };

        const readNode = async (): Promise<any> => {
            await yieldCpu(); // Yield check at start of node read

            if (offset >= buffer.byteLength) return null;
            const is75 = version >= 7500;
            
            // Bounds check for header read
            const headerSize = (is75 ? 25 : 13);
            if (offset + headerSize > buffer.byteLength) return null;

            const endOffset = is75 ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
            const numProps = is75 ? Number(view.getBigUint64(offset + 8, true)) : view.getUint32(offset + 4, true);
            const nameLen = view.getUint8(offset + (is75 ? 24 : 12));
            
            if (endOffset === 0) { offset += headerSize; return null; }
            if (endOffset > buffer.byteLength || endOffset < offset) return null; // Corrupted offset

            const name = new TextDecoder().decode(new Uint8Array(buffer, offset + headerSize, nameLen));
            offset += headerSize + nameLen;
            
            const props: any[] = [];
            for (let i = 0; i < numProps; i++) {
                if (offset >= buffer.byteLength) break;
                const typeCode = String.fromCharCode(view.getUint8(offset));
                offset++;
                if ('dfilb'.includes(typeCode)) props.push(await readArrayProp(typeCode));
                else if (typeCode === 'D') { props.push(view.getFloat64(offset, true)); offset += 8; }
                else if (typeCode === 'F') { props.push(view.getFloat32(offset, true)); offset += 4; }
                else if (typeCode === 'I') { props.push(view.getInt32(offset, true)); offset += 4; }
                else if (typeCode === 'L') { props.push(Number(view.getBigInt64(offset, true))); offset += 8; }
                else if (typeCode === 'Y') { props.push(view.getInt16(offset, true)); offset += 2; }
                else if (typeCode === 'C') { props.push(view.getUint8(offset) !== 0); offset += 1; }
                else if (typeCode === 'S' || typeCode === 'R') {
                    const len = view.getUint32(offset, true); offset += 4;
                    if (offset + len > buffer.byteLength) { offset = endOffset; break; }
                    const d = new Uint8Array(buffer, offset, len);
                    props.push(typeCode === 'S' ? new TextDecoder().decode(d) : d);
                    offset += len;
                }
            }
            
            const children = [];
            // Recursion limit safety not implemented, but loop checks offset
            while (offset < endOffset) {
                const startOff = offset; // Safety check
                const child = await readNode();
                if (!child) break;
                if (offset <= startOff) {
                    console.warn("FBX Parser stuck: offset not advancing. Breaking node.");
                    offset = endOffset;
                    break;
                }
                children.push(child);
                if (child.name === 'Vertices') finalV = child.props[0];
                if (child.name === 'PolygonVertexIndex') finalIdx = child.props[0];
                if (child.name === 'UV') finalUV = child.props[0];
                if (child.name === 'UVIndex') finalUVIdx = child.props[0];
            }
            offset = endOffset; // Ensure alignment
            return { name, props, children };
        };

        try { while (offset < buffer.byteLength - 160) { await readNode(); } } catch (e) { console.error(e); }

        // Construct Geometry
        let geometry: any = { v: [], n: [], u: [], idx: [], faces: [], triToFace: [], jointIndices: [], jointWeights: [] };
        if (finalV && finalV.length > 0 && finalIdx && finalIdx.length > 0) {
            const outV: number[] = []; const outN: number[] = []; const outU: number[] = []; const outIdx: number[] = [];
            const logicalFaces: number[][] = []; const triToFace: number[] = [];
            const cache = new Map<string, number>();
            let nextIndex = 0; let polyVertIndex = 0; let polygon: number[] = [];

            for (let i = 0; i < finalIdx.length; i++) {
                if (i % 1000 === 0) await yieldCpu(); // Yield during geometry processing

                let rawIdx = finalIdx[i]; let isEnd = false;
                if (rawIdx < 0) { rawIdx = (rawIdx ^ -1); isEnd = true; }
                
                // Safety check for indices out of bounds
                if (rawIdx * 3 + 2 >= finalV.length) {
                    continue; // Skip malformed vertex
                }

                let u = 0, v = 0;
                if (finalUV.length > 0) {
                    let uvIdx = polyVertIndex;
                    if (finalUVIdx.length > 0) uvIdx = finalUVIdx[polyVertIndex] ?? 0;
                    if (uvIdx >= 0 && uvIdx * 2 + 1 < finalUV.length) {
                        u = finalUV[uvIdx * 2]; v = finalUV[uvIdx * 2 + 1];
                    }
                }
                const key = `${rawIdx}:${u.toFixed(5)}:${v.toFixed(5)}`;
                let newIdx = -1;
                if (cache.has(key)) { newIdx = cache.get(key)!; } 
                else {
                    outV.push(finalV[rawIdx*3]*importScale, finalV[rawIdx*3+1]*importScale, finalV[rawIdx*3+2]*importScale);
                    outU.push(u, v); outN.push(0, 0, 0); newIdx = nextIndex++; cache.set(key, newIdx);
                }
                polygon.push(newIdx); polyVertIndex++;
                if (isEnd) {
                    if (polygon.length >= 3) {
                        const faceIdx = logicalFaces.length;
                        logicalFaces.push([...polygon]);
                        for (let k = 1; k < polygon.length - 1; k++) {
                            outIdx.push(polygon[0], polygon[k], polygon[k+1]);
                            triToFace.push(faceIdx);
                        }
                    }
                    polygon = [];
                }
            }
            this.generateMissingNormals(outV, outN, outIdx);
            geometry = { v: outV, n: outN, u: outU, idx: outIdx, faces: logicalFaces, triToFace };
        } else {
            geometry = this.generateCylinder(24);
        }

        // Placeholder Skeleton (In a real implementation, we'd parse the 'Objects' -> 'Model' nodes)
        // For now, return a single Root bone to enable skinning logic
        return { 
            geometry, 
            skeleton: { bones: [{ name: 'Root', parentIndex: -1, bindPose: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]) }] }
        };
    }

    private parseFBXASCII(text: string, importScale: number) {
        // ... (Keep existing ASCII implementation, but wrap return to match binary structure)
        try {
            const vMatch = text.match(/Vertices:\s*\*(\d+)\s*{([^}]*)}/);
            const iMatch = text.match(/PolygonVertexIndex:\s*\*(\d+)\s*{([^}]*)}/);
            const uMatch = text.match(/UV:\s*\*(\d+)\s*{([^}]*)}/);
            const uIdxMatch = text.match(/UVIndex:\s*\*(\d+)\s*{([^}]*)}/);

            if (vMatch && iMatch) {
                const verts = vMatch[2].split(',').map(s => parseFloat(s.trim()));
                const indices = iMatch[2].split(',').map(s => parseInt(s.trim()));
                let uvData: number[] = []; let uvIndices: number[] = [];
                if (uMatch) uvData = uMatch[2].split(',').map(s => parseFloat(s.trim()));
                if (uIdxMatch) uvIndices = uIdxMatch[2].split(',').map(s => parseInt(s.trim()));

                const outV: number[] = []; const outU: number[] = []; const outN: number[] = []; const outIdx: number[] = [];
                const logicalFaces: number[][] = []; const triToFace: number[] = [];
                const cache = new Map<string, number>();
                let nextIndex = 0; let polyVertIndex = 0; let polygon: number[] = [];

                for (let i = 0; i < indices.length; i++) {
                    let rawIdx = indices[i]; let isEnd = false;
                    if (rawIdx < 0) { rawIdx = (rawIdx ^ -1); isEnd = true; }
                    let u = 0, v = 0;
                    if (uvData.length > 0) {
                        let uvIdx = polyVertIndex;
                        if (uvIndices.length > 0) uvIdx = uvIndices[polyVertIndex] ?? 0;
                        if (uvIdx >= 0 && uvIdx * 2 + 1 < uvData.length) { u = uvData[uvIdx * 2]; v = uvData[uvIdx * 2 + 1]; }
                    }
                    const key = `${rawIdx}:${u.toFixed(5)}:${v.toFixed(5)}`;
                    let newIdx = -1;
                    if (cache.has(key)) { newIdx = cache.get(key)!; } 
                    else {
                        outV.push(verts[rawIdx*3]*importScale, verts[rawIdx*3+1]*importScale, verts[rawIdx*3+2]*importScale);
                        outU.push(u, v); outN.push(0, 0, 0); newIdx = nextIndex++; cache.set(key, newIdx);
                    }
                    polygon.push(newIdx); polyVertIndex++;
                    if (isEnd) {
                        const faceIdx = logicalFaces.length;
                        logicalFaces.push([...polygon]);
                        for (let k = 1; k < polygon.length - 1; k++) {
                            outIdx.push(polygon[0], polygon[k], polygon[k+1]);
                            triToFace.push(faceIdx);
                        }
                        polygon = [];
                    }
                }
                this.generateMissingNormals(outV, outN, outIdx);
                return { 
                    geometry: { v: outV, n: outN, u: outU, idx: outIdx, faces: logicalFaces, triToFace },
                    skeleton: { bones: [{ name: 'Root', parentIndex: -1, bindPose: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]) }] }
                };
            }
        } catch (e) { }
        return { geometry: this.generateCylinder(24), skeleton: null };
    }

    private generateMissingNormals(v: number[], n: number[], idx: number[]) {
        if (v.length > 0) {
            for (let i = 0; i < idx.length; i += 3) {
                const i1 = idx[i] * 3, i2 = idx[i+1] * 3, i3 = idx[i+2] * 3;
                const v1 = [v[i2] - v[i1], v[i2+1] - v[i1+1], v[i2+2] - v[i1+2]];
                const v2 = [v[i3] - v[i1], v[i3+1] - v[i1+1], v[i3+2] - v[i1+2]];
                const nx = v1[1] * v2[2] - v1[2] * v2[1];
                const ny = v1[2] * v2[0] - v1[0] * v2[1];
                const nz = v1[0] * v2[1] - v1[1] * v2[0];
                const l = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
                [idx[i], idx[i+1], idx[i+2]].forEach(vIdx => {
                    n[vIdx*3] = nx/l; n[vIdx*3+1] = ny/l; n[vIdx*3+2] = nz/l;
                });
            }
        }
    }

    private generateCylinder(segments: number) {
        const v=[], n=[], u=[], idx=[], faces: number[][] = [], triToFace: number[] = [];
        const radius = 0.5; const height = 1.0; const halfH = height/2;
        for(let i=0; i<=segments; i++) {
            const theta = (i/segments)*Math.PI*2; const x = Math.cos(theta)*radius; const z = Math.sin(theta)*radius;
            v.push(x, halfH, z); n.push(x, 0, z); u.push(i/segments, 0); v.push(x, -halfH, z); n.push(x, 0, z); u.push(i/segments, 1);
        }
        for(let i=0; i<segments; i++) { 
            const base = i*2; const fIdx = faces.length;
            faces.push([base, base+1, base+3, base+2]);
            idx.push(base, base+1, base+2, base+1, base+3, base+2);
            triToFace.push(fIdx, fIdx);
        }
        return { v, n, u, idx, faces, triToFace };
    }

    /**
     * Procedural Quad Sphere Generation (Maya/Industry Style)
     * Subdivides a cube and normalizes vertices to sphere surface.
     */
    private generateQuadSphere(subdivisions: number = 24) {
        const vertices: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const faces: number[][] = [];
        const triToFace: number[] = [];

        const step = 1.0 / subdivisions;
        let vOffset = 0;

        // Cube face origins and axes
        const origins = [
            [-0.5, -0.5,  0.5], [ 0.5, -0.5,  0.5], [ 0.5, -0.5, -0.5],
            [-0.5, -0.5, -0.5], [-0.5,  0.5,  0.5], [-0.5, -0.5, -0.5]
        ];
        const rightAxes = [
            [ 1, 0, 0], [ 0, 0,-1], [-1, 0, 0],
            [ 0, 0, 1], [ 1, 0, 0], [ 1, 0, 0]
        ];
        const upAxes = [
            [ 0, 1, 0], [ 0, 1, 0], [ 0, 1, 0],
            [ 0, 1, 0], [ 0, 0,-1], [ 0, 0, 1]
        ];

        for (let f = 0; f < 6; f++) {
            const origin = origins[f];
            const r = rightAxes[f];
            const u = upAxes[f];

            for (let j = 0; j <= subdivisions; j++) {
                for (let i = 0; i <= subdivisions; i++) {
                    const px = origin[0] + i * step * r[0] + j * step * u[0];
                    const py = origin[1] + i * step * r[1] + j * step * u[1];
                    const pz = origin[2] + i * step * r[2] + j * step * u[2];

                    // Normalize to sphere
                    const length = Math.sqrt(px * px + py * py + pz * pz);
                    const nx = px / length;
                    const ny = py / length;
                    const nz = pz / length;

                    // Standard radius 0.5
                    vertices.push(nx * 0.5, ny * 0.5, nz * 0.5);
                    normals.push(nx, ny, nz);
                    
                    // Simple spherical UV mapping
                    const uVal = 0.5 + (Math.atan2(nz, nx) / (2 * Math.PI));
                    const vVal = 0.5 - (Math.asin(ny) / Math.PI);
                    uvs.push(uVal, vVal);
                }
            }

            for (let j = 0; j < subdivisions; j++) {
                for (let i = 0; i < subdivisions; i++) {
                    const base = vOffset + j * (subdivisions + 1) + i;
                    const next = base + 1;
                    const top = base + (subdivisions + 1);
                    const topNext = top + 1;

                    const faceIdx = faces.length;
                    faces.push([base, next, topNext, top]);
                    
                    indices.push(base, next, topNext);
                    indices.push(base, topNext, top);
                    triToFace.push(faceIdx, faceIdx);
                }
            }
            vOffset += (subdivisions + 1) * (subdivisions + 1);
        }

        return { v: vertices, n: normals, u: uvs, idx: indices, faces, triToFace };
    }

    private createPrimitive(name: string, generator: () => any): StaticMeshAsset {
        const data = generator();
        const v2f = new Map<number, number[]>();
        data.faces?.forEach((f: number[], i: number) => f.forEach(v => { if(!v2f.has(v)) v2f.set(v, []); v2f.get(v)!.push(i); }));
        return { 
            id: crypto.randomUUID(), name: `SM_${name}`, type: 'MESH', isProtected: true, path: '/Content/Meshes',
            geometry: { vertices: new Float32Array(data.v), normals: new Float32Array(data.n), uvs: new Float32Array(data.u), indices: new Uint16Array(data.idx) },
            topology: data.faces ? { faces: data.faces, triangleToFaceIndex: new Int32Array(data.triToFace), vertexToFaces: v2f } : undefined
        };
    }

    private registerDefaultAssets() {
        this.registerAsset(this.createPrimitive('Cube', () => {
            const v = [ -0.5,-0.5,0.5, 0.5,-0.5,0.5, 0.5,0.5,0.5, -0.5,0.5,0.5, 0.5,-0.5,-0.5, -0.5,-0.5,-0.5, -0.5,0.5,-0.5, 0.5,0.5,-0.5, -0.5,0.5,0.5, 0.5,0.5,0.5, 0.5,0.5,-0.5, -0.5,0.5,-0.5, -0.5,-0.5,-0.5, 0.5,-0.5,-0.5, 0.5,-0.5,0.5, -0.5,-0.5,0.5, 0.5,-0.5,0.5, 0.5,-0.5,-0.5, 0.5,0.5,-0.5, 0.5,0.5,0.5, -0.5,-0.5,-0.5, -0.5,-0.5,0.5, -0.5,0.5,0.5, -0.5,0.5,-0.5 ];
            const n = [ 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 1,0,0, 1,0,0, 1,0,0, 1,0,0, -1,0,0, -1,0,0, -1,0,0, -1,0,0 ];
            const u = [ 0,0, 1,0, 1,1, 0,1, 0,0, 1,0, 1,1, 0,1, 0,0, 1,0, 1,1, 0,1, 0,0, 1,0, 1,1, 0,1, 0,0, 1,0, 1,1, 0,1 ];
            const idx = [ 0,1,2, 0,2,3, 4,5,6, 4,6,7, 8,9,10, 8,10,11, 12,13,14, 12,14,15, 16,17,18, 16,18,19, 20,21,22, 20,22,23 ];
            const faces = [ [0,1,2,3], [4,5,6,7], [8,9,10,11], [12,13,14,15], [16,17,18,19], [20,21,22,23] ];
            const triToFace = [ 0,0, 1,1, 2,2, 3,3, 4,4, 5,5 ];
            return { v, n, u, idx, faces, triToFace };
        }), MESH_TYPES['Cube']);

        this.registerAsset(this.createPrimitive('Sphere', () => this.generateQuadSphere(24)), MESH_TYPES['Sphere']);

        this.registerAsset(this.createPrimitive('Plane', () => ({ 
            v: [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 
            n: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 
            u: [0, 0, 1, 0, 1, 1, 0, 1], 
            idx: [0, 1, 2, 0, 2, 3],
            faces: [[0, 1, 2, 3]],
            triToFace: [0, 0]
        })), MESH_TYPES['Plane']);
        
        // Register Root Folders
        this.registerAsset({ id: 'root_content', name: 'Content', type: 'FOLDER', path: '/' });
        this.registerAsset({ id: 'folder_mat', name: 'Materials', type: 'FOLDER', path: '/Content' });
        this.registerAsset({ id: 'folder_mesh', name: 'Meshes', type: 'FOLDER', path: '/Content' });
        this.registerAsset({ id: 'folder_tex', name: 'Textures', type: 'FOLDER', path: '/Content' });
        this.registerAsset({ id: 'folder_rig', name: 'Rigs', type: 'FOLDER', path: '/Content' });
        this.registerAsset({ id: 'folder_phys', name: 'Physics', type: 'FOLDER', path: '/Content' });
        this.registerAsset({ id: 'folder_scr', name: 'Scripts', type: 'FOLDER', path: '/Content' });
    }
}
export const assetManager = new AssetManagerService();
