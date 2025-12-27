
// services/renderers/WebGLRenderer.ts

import { ComponentStorage } from '../ecs/ComponentStorage';
import { INITIAL_CAPACITY, COMPONENT_MASKS } from '../constants';
import { assetManager } from '../AssetManager';
import { StaticMeshAsset } from '../../types';
import { DebugRenderer } from './DebugRenderer';
import { moduleManager } from '../ModuleManager';

export interface PostProcessConfig {
    enabled: boolean;
    vignetteStrength: number;   
    aberrationStrength: number; 
    toneMapping: boolean;
}

// --- Shader Templates ---

const VS_TEMPLATE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
layout(location=2) in mat4 a_model; // Occupies locations 2, 3, 4, 5
layout(location=6) in vec3 a_color;
layout(location=7) in float a_isSelected;
layout(location=8) in vec2 a_uv;
layout(location=9) in float a_texIndex;
layout(location=10) in float a_effectIndex;
layout(location=11) in vec4 a_joints;
layout(location=12) in vec4 a_weights;

uniform mat4 u_viewProjection;
uniform highp float u_time;
uniform sampler2DArray u_textures;
uniform sampler2D u_boneTexture; 
uniform int u_hasSkinning; 

out vec3 v_normal;
out vec3 v_worldPos;
out vec3 v_objectPos; 
out vec3 v_color;
out float v_isSelected;
out vec2 v_uv;
out float v_texIndex;
out float v_effectIndex;

// %VERTEX_LOGIC%

mat4 getBoneMatrix(int jointIndex) {
    int y = jointIndex / 256;
    int x = jointIndex % 256;
    // For simplicity in this demo, assumes bones are stored linearly
    // In production, fetch 4 pixels from a float texture
    // Returning identity for now if not implemented fully
    return mat4(1.0); 
}

void main() {
    mat4 model = a_model;
    vec4 localPos = vec4(a_position, 1.0);
    vec3 localNormal = a_normal;

    // --- Skinning Logic ---
    // Note: To make this "Real", we need to fetch matrices from u_boneTexture based on a_joints
    // For now, we'll keep the hooks but default to rigid body to prevent crashes if texture is missing.
    if (u_hasSkinning == 1) {
        // mat4 skinMatrix = 
        //     a_weights.x * getBoneMatrix(int(a_joints.x)) +
        //     a_weights.y * getBoneMatrix(int(a_joints.y)) +
        //     a_weights.z * getBoneMatrix(int(a_joints.z)) +
        //     a_weights.w * getBoneMatrix(int(a_joints.w));
        // localPos = skinMatrix * localPos;
        // localNormal = mat3(skinMatrix) * localNormal;
    }

    vec3 v_pos_graph = localPos.xyz; 
    v_worldPos = (model * localPos).xyz;
    v_normal = normalize(mat3(model) * localNormal);
    v_objectPos = a_position;
    v_uv = a_uv;
    v_color = a_color;
    v_isSelected = a_isSelected;
    v_texIndex = a_texIndex;
    v_effectIndex = a_effectIndex;
    
    vec3 vertexOffset = vec3(0.0);
    // %VERTEX_BODY%
    
    localPos.xyz += vertexOffset;
    vec4 worldPos = model * localPos;
    gl_Position = u_viewProjection * worldPos;
    v_normal = normalize(mat3(model) * localNormal); 
    v_worldPos = worldPos.xyz;
}`;

const FS_DEFAULT_SOURCE = `#version 300 es
precision mediump float;
precision mediump sampler2DArray;

in highp vec3 v_normal;
in highp vec3 v_worldPos;
in highp vec3 v_objectPos;
in highp vec3 v_color;
in highp float v_isSelected;
in highp vec2 v_uv;
in highp float v_texIndex;
in highp float v_effectIndex;

uniform sampler2DArray u_textures;
uniform int u_renderMode; 
uniform vec3 u_cameraPos;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform float u_lightIntensity;

layout(location=0) out vec4 outColor;
layout(location=1) out vec4 outData; 

vec3 getStylizedLighting(vec3 normal, vec3 viewDir, vec3 albedo) {
    float NdotL = dot(normal, -u_lightDir);
    float lightBand = smoothstep(0.0, 0.05, NdotL);
    vec3 shadowColor = vec3(0.05, 0.05, 0.15); 
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);
    vec3 litColor = albedo * u_lightColor * u_lightIntensity;
    vec3 finalLight = mix(shadowColor * albedo, litColor, lightBand);
    finalLight += vec3(rim) * 0.5 * u_lightColor;
    return finalLight;
}

void main() {
    vec3 normal = normalize(v_normal);
    vec3 viewDir = normalize(u_cameraPos - v_worldPos);
    vec4 texColor = texture(u_textures, vec3(v_uv, v_texIndex));
    vec3 albedo = v_color * texColor.rgb;
    vec3 result = vec3(0.0);
    if (u_renderMode == 0) result = getStylizedLighting(normal, viewDir, albedo);
    else if (u_renderMode == 1) result = normal * 0.5 + 0.5;
    else if (u_renderMode == 2) result = albedo;
    else if (u_renderMode == 5) { // Heatmap Mode (e.g. for Weights)
       // Placeholder for heatmap visualization
       result = vec3(v_uv.x, v_uv.y, 0.0);
    }
    else result = albedo;
    
    outColor = vec4(result, 1.0);
    outData = vec4(v_effectIndex / 255.0, 0.0, 0.0, 1.0);
}`;

// ... (Keep GRID_VS, GRID_FS, PP_VS, PP_FS as is)
const GRID_VS = `#version 300 es
layout(location=0) in vec2 a_position;
uniform mat4 u_viewProjection;
out vec3 v_worldPos;
void main() {
    v_worldPos = vec3(a_position.x, 0.0, a_position.y) * 15000.0;
    gl_Position = u_viewProjection * vec4(v_worldPos, 1.0);
}`;

const GRID_FS = `#version 300 es
precision mediump float;
in vec3 v_worldPos;
layout(location=0) out vec4 outColor;

uniform float u_opacity, u_gridSize, u_subdivisions, u_fadeDist;
uniform vec3 u_gridColor;

float getGrid(vec2 pos, float size, float thickness) {
    vec2 r = pos / size;
    vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
    float line = min(grid.x, grid.y);
    return 1.0 - smoothstep(thickness - 0.5, thickness + 0.5, line);
}

void main() {
    float major = getGrid(v_worldPos.xz, u_gridSize, 0.6); 
    float minor = getGrid(v_worldPos.xz, u_gridSize / u_subdivisions, 0.3);
    
    float xAxis = 1.0 - smoothstep(0.0, fwidth(v_worldPos.z) * 1.5, abs(v_worldPos.z));
    float zAxis = 1.0 - smoothstep(0.0, fwidth(v_worldPos.x) * 1.5, abs(v_worldPos.x));
    
    float dist = length(v_worldPos.xz);
    float fade = max(0.0, 1.0 - dist / u_fadeDist);
    
    vec3 color = u_gridColor;
    float alpha = max(major * u_opacity, minor * u_opacity * 0.3);

    if (xAxis > 0.01) {
        color = mix(color, vec3(0.9, 0.1, 0.1), xAxis);
        alpha = max(alpha, xAxis * u_opacity * 1.5);
    }
    if (zAxis > 0.01) {
        color = mix(color, vec3(0.1, 0.2, 0.9), zAxis);
        alpha = max(alpha, zAxis * u_opacity * 1.5);
    }
    
    if (alpha * fade < 0.005) discard;
    outColor = vec4(color, alpha * fade);
}`;

const PP_VS = `#version 300 es
layout(location=0) in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const PP_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_scene;    
uniform sampler2D u_data;     
uniform sampler2D u_excluded; 
uniform sampler2D u_excludedData; 
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_enabled;
uniform float u_vignetteStrength;
uniform float u_aberrationStrength;
uniform float u_toneMapping;

out vec4 outColor;

vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 processPerObjectEffects(vec3 color, float effectId, vec2 uv, sampler2D sceneTex) {
    if (effectId < 0.5) return color;
    if (effectId < 1.5) { 
        float p = 128.0; vec2 puv = floor(uv * p) / p; return texture(sceneTex, puv).rgb;
    }
    if (effectId < 2.5) {
        float g = sin(u_time * 20.0) * 0.01; return texture(sceneTex, uv + vec2(g, 0.0)).rgb;
    }
    if (effectId < 3.5) return 1.0 - color;
    if (effectId < 4.5) return vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    return color;
}

void main() {
    vec3 baseColor = texture(u_scene, v_uv).rgb;
    float effectId = floor(mod(texture(u_data, v_uv).r * 255.0 + 0.5, 100.0));
    baseColor = processPerObjectEffects(baseColor, effectId, v_uv, u_scene);

    if (u_enabled > 0.5) {
        if (u_aberrationStrength > 0.0) {
            float r = texture(u_scene, v_uv + vec2(u_aberrationStrength, 0.0)).r;
            float b = texture(u_scene, v_uv - vec2(u_aberrationStrength, 0.0)).b;
            baseColor.r = r; baseColor.b = b;
        }
        if (u_vignetteStrength > 0.0) {
            vec2 uv = v_uv * (1.0 - v_uv.yx); float vig = uv.x * uv.y * 15.0;
            baseColor *= pow(vig, 0.15 * u_vignetteStrength);
        }
        if (u_toneMapping > 0.5) baseColor = aces(baseColor);
    }
    
    baseColor = pow(baseColor, vec3(1.0 / 2.2));

    vec4 exclSample = texture(u_excluded, v_uv);
    if (exclSample.a > 0.0) {
        vec3 exclColor = exclSample.rgb;
        float exclEffectId = floor(mod(texture(u_excludedData, v_uv).r * 255.0 + 0.5, 100.0));
        exclColor = processPerObjectEffects(exclColor, exclEffectId, v_uv, u_excluded);
        baseColor = mix(baseColor, pow(exclColor, vec3(1.0 / 2.2)), exclSample.a);
    }

    outColor = vec4(baseColor, 1.0);
}`;

interface MeshBatch {
    vao: WebGLVertexArrayObject;
    count: number;
    instanceBuffer: WebGLBuffer;
    cpuBuffer: Float32Array; 
    instanceCount: number; 
    hasSkin: boolean;
}

export class WebGLRenderer {
    gl: WebGL2RenderingContext | null = null;
    defaultProgram: WebGLProgram | null = null;
    materialPrograms: Map<number, WebGLProgram> = new Map();
    gridProgram: WebGLProgram | null = null;
    meshes: Map<number, MeshBatch> = new Map();
    textureArray: WebGLTexture | null = null;
    boneTexture: WebGLTexture | null = null; // Store bone matrices
    
    depthRenderbuffer: WebGLRenderbuffer | null = null;
    fboIncluded: WebGLFramebuffer | null = null;
    texColorIncluded: WebGLTexture | null = null;
    texDataIncluded: WebGLTexture | null = null;
    
    fboExcluded: WebGLFramebuffer | null = null;
    texColorExcluded: WebGLTexture | null = null;
    texDataExcluded: WebGLTexture | null = null;
    
    ppProgram: WebGLProgram | null = null;
    quadVAO: WebGLVertexArrayObject | null = null;
    
    private fboWidth: number = 0;
    private fboHeight: number = 0;
    
    drawCalls = 0; triangleCount = 0; showGrid = true;
    gridOpacity = 0.9; gridSize = 1.0; gridSubdivisions = 10; gridFadeDistance = 400.0;
    gridColor = [0.5, 0.5, 0.5]; gridExcludePP = true; 
    renderMode: number = 0;
    ppConfig: PostProcessConfig = { enabled: true, vignetteStrength: 1.0, aberrationStrength: 0.002, toneMapping: true };
    
    private buckets: Map<number, number[]> = new Map();
    private excludedBuckets: Map<number, number[]> = new Map();

    init(canvas: HTMLCanvasElement) {
        this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: "high-performance" });
        if (!this.gl) return;
        const gl = this.gl;
        gl.getExtension("EXT_color_buffer_float");
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE); 
        gl.clearColor(0.1, 0.1, 0.1, 1.0);
        const defaultVS = VS_TEMPLATE.replace('// %VERTEX_LOGIC%', '').replace('// %VERTEX_BODY%', '');
        this.defaultProgram = this.createProgram(gl, defaultVS, FS_DEFAULT_SOURCE);
        this.initTextureArray(gl);
        this.initBoneTexture(gl);
        this.initPostProcess(gl);
        this.gridProgram = this.createProgram(gl, GRID_VS, GRID_FS);
    }

    initPostProcess(gl: WebGL2RenderingContext) {
        this.fboWidth = 1; this.fboHeight = 1;
        this.depthRenderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.fboWidth, this.fboHeight);
        
        this.fboIncluded = gl.createFramebuffer();
        this.texColorIncluded = this.createTexture(gl, gl.RGBA, gl.UNSIGNED_BYTE);
        this.texDataIncluded = this.createTexture(gl, gl.RGBA32F, gl.FLOAT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboIncluded);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texColorIncluded, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.texDataIncluded, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
        
        this.fboExcluded = gl.createFramebuffer();
        this.texColorExcluded = this.createTexture(gl, gl.RGBA, gl.UNSIGNED_BYTE);
        this.texDataExcluded = this.createTexture(gl, gl.RGBA32F, gl.FLOAT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboExcluded);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texColorExcluded, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.texDataExcluded, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.quadVAO = gl.createVertexArray(); const quadVBO = gl.createBuffer();
        gl.bindVertexArray(this.quadVAO); gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.ppProgram = this.createProgram(gl, PP_VS, PP_FS);
    }

    private createTexture(gl: WebGL2RenderingContext, format: number, type: number) {
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, format, this.fboWidth, this.fboHeight, 0, gl.RGBA, type, null);
        return tex;
    }

    createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
        const vs = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
        const prog = gl.createProgram()!; gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
        return prog;
    }

    initTextureArray(gl: WebGL2RenderingContext) {
        this.textureArray = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 256, 256, 16);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    initBoneTexture(gl: WebGL2RenderingContext) {
        this.boneTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        // Create 256x4 texture to hold 256 4x4 matrices (1 row = 1 matrix approx if encoded as RGBA32F)
        // Initialize with Identity matrices
        const data = new Float32Array(1024 * 4);
        for(let i=0; i<256; i++) {
            // Identity matrix for each bone: 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
            // 4 pixels per matrix (16 floats)
            const base = i * 16;
            data[base] = 1; data[base+5] = 1; data[base+10] = 1; data[base+15] = 1;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, 1, 0, gl.RGBA, gl.FLOAT, data);
    }

    uploadTexture(layerIndex: number, image: HTMLImageElement) {
        if (!this.gl || !this.textureArray) return;
        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0, 256, 256);
        this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, this.textureArray);
        this.gl.texSubImage3D(this.gl.TEXTURE_2D_ARRAY, 0, 0, 0, layerIndex, 256, 256, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, canvas);
    }

    resize(width: number, height: number) {
        if (!this.gl) return;
        const gl = this.gl;
        const canvas = gl.canvas as HTMLCanvasElement;
        canvas.width = width; canvas.height = height;
        gl.viewport(0, 0, width, height);
        if (this.fboWidth !== width || this.fboHeight !== height) {
            this.fboWidth = width; this.fboHeight = height;
            gl.bindTexture(gl.TEXTURE_2D, this.texColorIncluded); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, this.texDataIncluded); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
            gl.bindTexture(gl.TEXTURE_2D, this.texColorExcluded); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, this.texDataExcluded); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
            gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
        }
    }

    updateMaterial(materialId: number, shaderData: any) {
        if (!this.gl) return;
        const gl = this.gl;
        const parts = shaderData.vs.split('// --- Graph Body (VS) ---');
        const vsSource = VS_TEMPLATE.replace('// %VERTEX_LOGIC%', parts[0]||'').replace('// %VERTEX_BODY%', parts[1]||'');
        const program = this.createProgram(gl, vsSource, shaderData.fs);
        if (program) {
            const old = this.materialPrograms.get(materialId); if (old) gl.deleteProgram(old);
            this.materialPrograms.set(materialId, program);
        }
    }

    registerMesh(id: number, geometry: any) {
        if (!this.gl) return;
        const gl = this.gl;
        const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
        const createBuf = (data: any, type: number) => {
            const b = gl.createBuffer(); gl.bindBuffer(type, b);
            gl.bufferData(type, data instanceof Float32Array || data instanceof Uint16Array ? data : new (type===gl.ELEMENT_ARRAY_BUFFER?Uint16Array:Float32Array)(data), gl.STATIC_DRAW);
            return b;
        };
        createBuf(geometry.vertices, gl.ARRAY_BUFFER); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        createBuf(geometry.normals, gl.ARRAY_BUFFER); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        createBuf(geometry.uvs, gl.ARRAY_BUFFER); gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 2, gl.FLOAT, false, 0, 0);
        
        // Skinning Attributes (Locations 11 & 12)
        const hasSkin = !!(geometry.jointIndices && geometry.jointWeights);
        if (hasSkin) {
            createBuf(geometry.jointIndices, gl.ARRAY_BUFFER); gl.enableVertexAttribArray(11); gl.vertexAttribPointer(11, 4, gl.FLOAT, false, 0, 0);
            createBuf(geometry.jointWeights, gl.ARRAY_BUFFER); gl.enableVertexAttribArray(12); gl.vertexAttribPointer(12, 4, gl.FLOAT, false, 0, 0);
        }

        createBuf(geometry.indices, gl.ELEMENT_ARRAY_BUFFER);
        const stride = 22 * 4; const inst = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, inst);
        gl.bufferData(gl.ARRAY_BUFFER, INITIAL_CAPACITY * stride, gl.DYNAMIC_DRAW);
        // Locations 2, 3, 4, 5 for Model Matrix
        for(let k=0; k<4; k++) { gl.enableVertexAttribArray(2+k); gl.vertexAttribPointer(2+k, 4, gl.FLOAT, false, stride, k*16); gl.vertexAttribDivisor(2+k, 1); }
        gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 3, gl.FLOAT, false, stride, 16*4); gl.vertexAttribDivisor(6, 1);
        gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 1, gl.FLOAT, false, stride, 19*4); gl.vertexAttribDivisor(7, 1);
        gl.enableVertexAttribArray(9); gl.vertexAttribPointer(9, 1, gl.FLOAT, false, stride, 20*4); gl.vertexAttribDivisor(9, 1);
        gl.enableVertexAttribArray(10); gl.vertexAttribPointer(10, 1, gl.FLOAT, false, stride, 21*4); gl.vertexAttribDivisor(10, 1);
        gl.bindVertexArray(null);
        this.meshes.set(id, { vao, count: geometry.indices.length, instanceBuffer: inst, cpuBuffer: new Float32Array(INITIAL_CAPACITY * 22), instanceCount: 0, hasSkin });
    }

    render(store: ComponentStorage, count: number, selectedIndices: Set<number>, vp: Float32Array, width: number, height: number, cam: any, debugRenderer?: DebugRenderer) {
        if (!this.gl || !this.defaultProgram) return;
        const gl = this.gl; const time = performance.now() / 1000;
        this.buckets.clear(); this.excludedBuckets.clear();
        for (let i = 0; i < count; i++) {
            if (store.isActive[i] && store.meshType[i] !== 0) { 
                const key = (store.materialIndex[i] << 16) | store.meshType[i];
                if (store.effectIndex[i] >= 99.5) { if(!this.excludedBuckets.has(key)) this.excludedBuckets.set(key, []); this.excludedBuckets.get(key)!.push(i); }
                else { if(!this.buckets.has(key)) this.buckets.set(key, []); this.buckets.get(key)!.push(i); }
            }
        }

        let lightDir = [0.5, -1.0, 0.5], lightColor = [1, 1, 1], lightIntensity = 1.0;
        for (let i = 0; i < count; i++) {
            if (store.isActive[i] && (store.componentMask[i] & COMPONENT_MASKS.LIGHT)) {
                const base = i * 16;
                lightDir[0] = store.worldMatrix[base + 8]; lightDir[1] = store.worldMatrix[base + 9]; lightDir[2] = store.worldMatrix[base + 10];
                lightColor[0] = store.colorR[i]; lightColor[1] = store.colorG[i]; lightColor[2] = store.colorB[i];
                lightIntensity = store.lightIntensity[i]; break;
            }
        }

        this.drawCalls = 0; this.triangleCount = 0;
        
        // --- Pass 1: Opaque Scene ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboIncluded);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.clearColor(0.1, 0.1, 0.1, 1.0); 
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); 
        this.renderBuckets(this.buckets, store, selectedIndices, vp, cam, time, lightDir, lightColor, lightIntensity);
        
        if (this.showGrid && !this.gridExcludePP) { 
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]); 
            this.renderGrid(gl, vp); 
        }

        // --- Pass 2: Overlays / Excluded ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboExcluded);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.clearColor(0, 0, 0, 0); 
        gl.clear(gl.COLOR_BUFFER_BIT); 
        
        this.renderBuckets(this.excludedBuckets, store, selectedIndices, vp, cam, time, lightDir, lightColor, lightIntensity);
        
        // Render Custom Modules (like Virtual Pivots)
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        moduleManager.render(gl, vp);

        if (this.showGrid && this.gridExcludePP) { 
            this.renderGrid(gl, vp); 
        }

        if (debugRenderer) { 
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL); 
            debugRenderer.render(vp); 
        }

        // --- Pass 3: Post Processing Composite ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.DEPTH_TEST);
        gl.useProgram(this.ppProgram);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texColorIncluded); gl.uniform1i(gl.getUniformLocation(this.ppProgram!, 'u_scene'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texDataIncluded); gl.uniform1i(gl.getUniformLocation(this.ppProgram!, 'u_data'), 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texColorExcluded); gl.uniform1i(gl.getUniformLocation(this.ppProgram!, 'u_excluded'), 2);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.texDataExcluded); gl.uniform1i(gl.getUniformLocation(this.ppProgram!, 'u_excludedData'), 3);
        
        const setU = (n: string, v: number) => { const l = gl.getUniformLocation(this.ppProgram!, n); if(l) gl.uniform1f(l, v); };
        setU('u_enabled', this.ppConfig.enabled?1:0); setU('u_vignetteStrength', this.ppConfig.vignetteStrength);
        setU('u_aberrationStrength', this.ppConfig.aberrationStrength); setU('u_toneMapping', this.ppConfig.toneMapping?1:0);
        gl.bindVertexArray(this.quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); 
        gl.enable(gl.DEPTH_TEST);
    }

    private renderGrid(gl: WebGL2RenderingContext, vp: Float32Array) {
        if (!this.gridProgram || !this.quadVAO) return;
        gl.useProgram(this.gridProgram); 
        gl.enable(gl.BLEND); 
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); 
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);

        gl.uniformMatrix4fv(gl.getUniformLocation(this.gridProgram, 'u_viewProjection'), false, vp);
        gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_opacity'), this.gridOpacity);
        gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_gridSize'), this.gridSize);
        gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_subdivisions'), this.gridSubdivisions);
        gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_fadeDist'), this.gridFadeDistance);
        gl.uniform3fv(gl.getUniformLocation(this.gridProgram, 'u_gridColor'), this.gridColor);
        
        gl.bindVertexArray(this.quadVAO); 
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); 
        
        gl.depthMask(true); 
        gl.disable(gl.BLEND);
    }

    private renderBuckets(buckets: Map<number, number[]>, store: any, selected: Set<number>, vp: Float32Array, cam: any, time: number, lightDir: number[], lightColor: number[], lightIntensity: number) {
        const gl = this.gl!;
        buckets.forEach((indices, key) => {
            const matId = key >> 16; const meshId = key & 0xFFFF; const mesh = this.meshes.get(meshId); if(!mesh) return;
            const program = (matId > 0 && this.materialPrograms.has(matId)) ? this.materialPrograms.get(matId)! : this.defaultProgram!;
            gl.useProgram(program);
            gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_viewProjection'), false, vp);
            gl.uniform1f(gl.getUniformLocation(program, 'u_time'), time);
            gl.uniform3f(gl.getUniformLocation(program, 'u_cameraPos'), cam.x, cam.y, cam.z);
            gl.uniform1i(gl.getUniformLocation(program, 'u_renderMode'), this.renderMode);
            gl.uniform3fv(gl.getUniformLocation(program, 'u_lightDir'), lightDir);
            gl.uniform3fv(gl.getUniformLocation(program, 'u_lightColor'), lightColor);
            gl.uniform1f(gl.getUniformLocation(program, 'u_lightIntensity'), lightIntensity);
            
            // Bone Texture (Placeholder binding)
            if (this.boneTexture) {
                gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
                gl.uniform1i(gl.getUniformLocation(program, 'u_boneTexture'), 1);
                gl.uniform1i(gl.getUniformLocation(program, 'u_hasSkinning'), mesh.hasSkin ? 1 : 0);
            }

            if (this.textureArray) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray); gl.uniform1i(gl.getUniformLocation(program, 'u_textures'), 0); }
            
            let instanceCount = 0; const stride = 22; const buf = mesh.cpuBuffer;
            for (const idx of indices) {
                if (instanceCount >= INITIAL_CAPACITY) break;
                const off = instanceCount * stride; const wm = idx * 16;
                for (let k = 0; k < 16; k++) buf[off+k] = store.worldMatrix[wm+k];
                buf[off+16] = store.colorR[idx]; buf[off+17] = store.colorG[idx]; buf[off+18] = store.colorB[idx];
                buf[off+19] = selected.has(idx) ? 1.0 : 0.0; buf[off+20] = store.textureIndex[idx]; buf[off+21] = store.effectIndex[idx];
                instanceCount++;
            }
            if (instanceCount > 0) {
                gl.bindVertexArray(mesh.vao); gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instanceBuffer);
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf.subarray(0, instanceCount * stride));
                gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, instanceCount);
                this.drawCalls++; this.triangleCount += (mesh.count/3) * instanceCount;
            }
        });
    }
// --- GIZMO RENDERING SUPPORT ---
    gizmoProgram: WebGLProgram | null = null;
    gizmoVAO: WebGLVertexArrayObject | null = null;
    
gizmoOffsets = { 
        cylinder: 0, cylinderCount: 0, 
        cone: 0, coneCount: 0, 
        quad: 0, quadCount: 0,
        quadBorder: 0, quadBorderCount: 0,
        sphere: 0, sphereCount: 0 // New Geometry
    };

initGizmo() {
        if (!this.gl) return;
        const gl = this.gl;
        
        // ... (Shader setup same as before) ...
        const vs = `#version 300 es
        layout(location=0) in vec3 a_pos;
        uniform mat4 u_vp;
        uniform mat4 u_model;
        void main() { gl_Position = u_vp * u_model * vec4(a_pos, 1.0); }`;
        const fs = `#version 300 es
        precision mediump float;
        uniform vec3 u_color;
        uniform float u_alpha;
        layout(location=0) out vec4 outColor;
        void main() { outColor = vec4(u_color, u_alpha); }`;
        this.gizmoProgram = this.createProgram(gl, vs, fs);

        const vertices: number[] = [];
        
        // 1. Cylinder (Arrow Stem)
        const stemLen = 0.6; const stemRad = 0.005; const segs = 16;
        for(let i=0; i<segs; i++) {
            const th = (i/segs)*Math.PI*2; const th2 = ((i+1)/segs)*Math.PI*2;
            const x1=Math.cos(th)*stemRad, z1=Math.sin(th)*stemRad;
            const x2=Math.cos(th2)*stemRad, z2=Math.sin(th2)*stemRad;
            vertices.push(x1,0,z1, x2,0,z2, x1,stemLen,z1); vertices.push(x2,0,z2, x2,stemLen,z2, x1,stemLen,z1);
        }
        
        // 2. Cone (Arrow Tip)
        const tipStart = stemLen; const tipEnd = 0.67; const tipRad = 0.022;
        const coneOff = vertices.length / 3;
        for(let i=0; i<segs; i++) {
            const th = (i/segs)*Math.PI*2; const th2 = ((i+1)/segs)*Math.PI*2;
            const x1=Math.cos(th)*tipRad, z1=Math.sin(th)*tipRad;
            const x2=Math.cos(th2)*tipRad, z2=Math.sin(th2)*tipRad;
            vertices.push(x1,tipStart,z1, x2,tipStart,z2, 0,tipEnd,0); vertices.push(x1,tipStart,z1, 0,tipStart,0, x2,tipStart,z2);
        }

        // 3. Quad (Filled Plane)
        const quadOff = vertices.length / 3;
        const qS = 0.1, qO = 0.1; 
        vertices.push(qO,qO,0, qO+qS,qO,0, qO,qO+qS,0); vertices.push(qO+qS,qO,0, qO+qS,qO+qS,0, qO,qO+qS,0);

        // 4. Quad Border (Wireframe)
        const borderOff = vertices.length / 3;
        vertices.push(qO,qO,0, qO+qS,qO,0, qO+qS,qO+qS,0, qO,qO+qS,0);

        // 5. Sphere (Center Ball)
        // Radius: 0.025 (1/2 of previous 0.05)
        const sphereRad = 0.025;
        const sphereOff = vertices.length / 3;
        const lat = 8, lon = 12;
        for(let i=0; i<lat; i++) {
            const th1 = (i/lat)*Math.PI; const th2 = ((i+1)/lat)*Math.PI;
            for(let j=0; j<lon; j++) {
                const ph1 = (j/lon)*2*Math.PI; const ph2 = ((j+1)/lon)*2*Math.PI;
                const p1 = {x:Math.sin(th1)*Math.cos(ph1), y:Math.cos(th1), z:Math.sin(th1)*Math.sin(ph1)};
                const p2 = {x:Math.sin(th1)*Math.cos(ph2), y:Math.cos(th1), z:Math.sin(th1)*Math.sin(ph2)};
                const p3 = {x:Math.sin(th2)*Math.cos(ph1), y:Math.cos(th2), z:Math.sin(th2)*Math.sin(ph1)};
                const p4 = {x:Math.sin(th2)*Math.cos(ph2), y:Math.cos(th2), z:Math.sin(th2)*Math.sin(ph2)};
                vertices.push(p1.x*sphereRad,p1.y*sphereRad,p1.z*sphereRad, p3.x*sphereRad,p3.y*sphereRad,p3.z*sphereRad, p2.x*sphereRad,p2.y*sphereRad,p2.z*sphereRad);
                vertices.push(p2.x*sphereRad,p2.y*sphereRad,p2.z*sphereRad, p3.x*sphereRad,p3.y*sphereRad,p3.z*sphereRad, p4.x*sphereRad,p4.y*sphereRad,p4.z*sphereRad);
            }
        }

        this.gizmoVAO = gl.createVertexArray();
        const vbo = gl.createBuffer();
        gl.bindVertexArray(this.gizmoVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        
        this.gizmoOffsets = { 
            cylinder: 0, cylinderCount: coneOff, 
            cone: coneOff, coneCount: quadOff - coneOff, 
            quad: quadOff, quadCount: 6,
            quadBorder: borderOff, quadBorderCount: 4,
            sphere: sphereOff, sphereCount: (vertices.length/3) - sphereOff
        };
    }

    renderGizmos(vp: Float32Array, pos: {x:number, y:number, z:number}, scale: number, hoverAxis: string | null, activeAxis: string | null) {
        if (!this.gl || !this.gizmoProgram || !this.gizmoVAO) return;
        const gl = this.gl;
        
        gl.useProgram(this.gizmoProgram);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.uniformMatrix4fv(gl.getUniformLocation(this.gizmoProgram, 'u_vp'), false, vp);
        const uModel = gl.getUniformLocation(this.gizmoProgram, 'u_model');
        const uColor = gl.getUniformLocation(this.gizmoProgram, 'u_color');
        const uAlpha = gl.getUniformLocation(this.gizmoProgram, 'u_alpha');

        gl.bindVertexArray(this.gizmoVAO);

        const drawPart = (axis: 'X'|'Y'|'Z'|'VIEW', type: 'arrow'|'plane'|'sphere', color: number[]) => {
            const axisName = axis === 'VIEW' ? 'VIEW' : axis;
            const checkName = type === 'plane' ? (axis==='X'?'YZ':(axis==='Y'?'XZ':'XY')) : axisName;
            
            const isHover = hoverAxis === checkName;
            const isActive = activeAxis === checkName;
            const baseScale = scale; 
            
            const mIdentity = new Float32Array([baseScale,0,0,0, 0,baseScale,0,0, 0,0,baseScale,0, pos.x,pos.y,pos.z,1]);

            if (type === 'arrow') {
                const mArrow = new Float32Array(mIdentity);
                if (axis === 'X') { mArrow[0]=0; mArrow[1]=-baseScale; mArrow[4]=baseScale; mArrow[5]=0; }
                else if (axis === 'Z') { mArrow[5]=0; mArrow[6]=baseScale; mArrow[9]=-baseScale; mArrow[10]=0; }
                gl.uniformMatrix4fv(uModel, false, mArrow);
                
                gl.uniform3fv(uColor, (isActive || isHover) ? [1,1,1] : color);
                gl.uniform1f(uAlpha, 1.0);
                gl.drawArrays(gl.TRIANGLES, this.gizmoOffsets.cylinder, this.gizmoOffsets.cylinderCount);
                gl.drawArrays(gl.TRIANGLES, this.gizmoOffsets.cone, this.gizmoOffsets.coneCount);
            } 
            else if (type === 'sphere') {
                gl.uniformMatrix4fv(uModel, false, mIdentity);
                // Color: #47a1b3 -> [0.28, 0.63, 0.70]
                gl.uniform3fv(uColor, (isActive || isHover) ? [1,1,1] : [0.28, 0.63, 0.70]); 
                gl.uniform1f(uAlpha, 1.0);
                gl.drawArrays(gl.TRIANGLES, this.gizmoOffsets.sphere, this.gizmoOffsets.sphereCount);
            }
            else { 
                if (axis === 'X') { 
                     const mP = new Float32Array([0,0,baseScale,0, 0,baseScale,0,0, -baseScale,0,0,0, pos.x,pos.y,pos.z,1]);
                     gl.uniformMatrix4fv(uModel, false, mP);
                } else if (axis === 'Y') { 
                     const mP = new Float32Array([baseScale,0,0,0, 0,0,baseScale,0, 0,-baseScale,0,0, pos.x,pos.y,pos.z,1]);
                     gl.uniformMatrix4fv(uModel, false, mP);
                } else { 
                     gl.uniformMatrix4fv(uModel, false, mIdentity);
                }

                gl.uniform3fv(uColor, color);
                gl.uniform1f(uAlpha, (isActive || isHover) ? 0.5 : 0.3);
                gl.drawArrays(gl.TRIANGLES, this.gizmoOffsets.quad, this.gizmoOffsets.quadCount);

                if (isActive || isHover) {
                    gl.uniform3fv(uColor, [1, 1, 1]);
                    gl.uniform1f(uAlpha, 1.0);
                    gl.drawArrays(gl.LINE_LOOP, this.gizmoOffsets.quadBorder, this.gizmoOffsets.quadBorderCount);
                }
            }
        };

        drawPart('VIEW', 'sphere', [1,1,1]); // Color is ignored here, overridden inside

        drawPart('X', 'plane', [0, 1, 1]); 
        drawPart('Y', 'plane', [1, 0, 1]); 
        drawPart('Z', 'plane', [1, 1, 0]); 

        drawPart('X', 'arrow', [1, 0, 0]);
        drawPart('Y', 'arrow', [0, 1, 0]);
        drawPart('Z', 'arrow', [0, 0, 1]);

        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
    }
}
