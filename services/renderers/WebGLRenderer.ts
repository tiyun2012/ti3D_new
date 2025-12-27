
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
out vec4 v_weights;
out vec4 v_joints;

// %VERTEX_LOGIC%

mat4 getBoneMatrix(int jointIndex) {
    if (jointIndex < 0) return mat4(1.0);
    // Fetch 4 pixels from 256x1 RGBA32F texture
    // Texture width 1024 (256 bones * 4 pixels per bone)
    // Pixel 0: col0, Pixel 1: col1, etc.
    int base = jointIndex * 4;
    vec4 c0 = texelFetch(u_boneTexture, ivec2(base, 0), 0);
    vec4 c1 = texelFetch(u_boneTexture, ivec2(base + 1, 0), 0);
    vec4 c2 = texelFetch(u_boneTexture, ivec2(base + 2, 0), 0);
    vec4 c3 = texelFetch(u_boneTexture, ivec2(base + 3, 0), 0);
    return mat4(c0, c1, c2, c3);
}

void main() {
    mat4 model = a_model;
    vec4 localPos = vec4(a_position, 1.0);
    vec3 localNormal = a_normal;

    if (u_hasSkinning == 1) {
        mat4 skinMatrix = 
            a_weights.x * getBoneMatrix(int(a_joints.x)) +
            a_weights.y * getBoneMatrix(int(a_joints.y)) +
            a_weights.z * getBoneMatrix(int(a_joints.z)) +
            a_weights.w * getBoneMatrix(int(a_joints.w));
        
        // If weights sum to 0 (static part of mesh), use identity
        if (dot(a_weights, vec4(1.0)) < 0.01) skinMatrix = mat4(1.0);

        localPos = skinMatrix * localPos;
        localNormal = mat3(skinMatrix) * localNormal;
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
    v_weights = a_weights;
    v_joints = a_joints;
    
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
in highp vec4 v_weights;
in highp vec4 v_joints;

uniform sampler2DArray u_textures;
uniform int u_renderMode; 
uniform vec3 u_cameraPos;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform float u_lightIntensity;
uniform int u_selectedBoneIndex; // For Heatmap

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
    else if (u_renderMode == 5) { // Skinning Heatmap
       float w = 0.0;
       float boneIdx = float(u_selectedBoneIndex);
       if (abs(v_joints.x - boneIdx) < 0.1) w += v_weights.x;
       if (abs(v_joints.y - boneIdx) < 0.1) w += v_weights.y;
       if (abs(v_joints.z - boneIdx) < 0.1) w += v_weights.z;
       if (abs(v_joints.w - boneIdx) < 0.1) w += v_weights.w;
       
       vec3 cold = vec3(0.0, 0.0, 0.5); // Deep Blue
       vec3 hot = vec3(1.0, 0.0, 0.0);  // Red
       vec3 med = vec3(1.0, 1.0, 0.0);  // Yellow
       
       vec3 heat = mix(cold, med, w * 2.0);
       if (w > 0.5) heat = mix(med, hot, (w - 0.5) * 2.0);
       
       // Wireframe overlay for context
       result = mix(vec3(0.1), heat, step(0.001, w));
    }
    else result = albedo;
    
    outColor = vec4(result, 1.0);
    outData = vec4(v_effectIndex / 255.0, 0.0, 0.0, 1.0);
}`;

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
    
    // Convert Base Scene to Gamma Space
    baseColor = pow(baseColor, vec3(1.0 / 2.2));

    // Composite Excluded Layer (e.g. Grid/Gizmos)
    vec4 exclSample = texture(u_excluded, v_uv);
    if (exclSample.a > 0.0) {
        vec3 exclColor = exclSample.rgb;
        float exclEffectId = floor(mod(texture(u_excludedData, v_uv).r * 255.0 + 0.5, 100.0));
        
        // 1. Un-premultiply to get straight color for processing
        vec3 straightColor = exclColor / exclSample.a;
        
        // 2. Apply effects
        straightColor = processPerObjectEffects(straightColor, exclEffectId, v_uv, u_excluded);
        
        // 3. Gamma Correct the overlay to match the destination buffer
        vec3 gammaOverlay = pow(straightColor, vec3(1.0 / 2.2));
        
        // 4. Standard Mix (OneMinusSrcAlpha composition)
        // base * (1-a) + overlay * a
        baseColor = baseColor * (1.0 - exclSample.a) + gammaOverlay * exclSample.a;
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
    selectedBoneIndex: number = -1; // For heatmap visualization
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

    initGizmo() {
        // Placeholder for gizmo resource initialization
    }

    resize(width: number, height: number) {
        if (!this.gl) return;
        // CRITICAL FIX: Ensure canvas buffer matches display size
        this.gl.canvas.width = width;
        this.gl.canvas.height = height;
        this.gl.viewport(0, 0, width, height);
        this.fboWidth = width;
        this.fboHeight = height;
        this.initPostProcess(this.gl); 
    }

    initPostProcess(gl: WebGL2RenderingContext) {
        // If resizing, delete old resources first
        if (this.fboIncluded) gl.deleteFramebuffer(this.fboIncluded);
        if (this.fboExcluded) gl.deleteFramebuffer(this.fboExcluded);
        if (this.texColorIncluded) gl.deleteTexture(this.texColorIncluded);
        if (this.texDataIncluded) gl.deleteTexture(this.texDataIncluded);
        if (this.texColorExcluded) gl.deleteTexture(this.texColorExcluded);
        if (this.texDataExcluded) gl.deleteTexture(this.texDataExcluded);
        if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);

        this.fboWidth = this.fboWidth || 1;
        this.fboHeight = this.fboHeight || 1;

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
        
        if (!this.quadVAO) {
            this.quadVAO = gl.createVertexArray(); const quadVBO = gl.createBuffer();
            gl.bindVertexArray(this.quadVAO); gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        }
        
        if (!this.ppProgram) this.ppProgram = this.createProgram(gl, PP_VS, PP_FS);
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
        const vs = gl.createShader(gl.VERTEX_SHADER)!; 
        gl.shaderSource(vs, vsSrc); 
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            console.error("VS Error:", gl.getShaderInfoLog(vs));
            return null;
        }

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!; 
        gl.shaderSource(fs, fsSrc); 
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            console.error("FS Error:", gl.getShaderInfoLog(fs));
            return null;
        }

        const prog = gl.createProgram()!; 
        gl.attachShader(prog, vs); 
        gl.attachShader(prog, fs); 
        gl.linkProgram(prog);

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
             console.error("Link Error:", gl.getProgramInfoLog(prog));
             return null;
        }
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

    uploadBoneMatrices(data: Float32Array) {
        if (!this.gl || !this.boneTexture) return;
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.boneTexture);
        // Expecting data size to match texture size (1024x1 RGBA32F = 4096 floats)
        // Only upload used part
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, 1024, 1, this.gl.RGBA, this.gl.FLOAT, data);
    }

    uploadTexture(layerIndex: number, image: HTMLImageElement) {
        if (!this.gl || !this.textureArray) return;
        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0, 256, 256);
        this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, this.textureArray);
        this.gl.texSubImage3D(this.gl.TEXTURE_2D_ARRAY, 0, 0, 0, layerIndex, 256, 256, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, canvas);
    }

    registerMesh(id: number, geometry: { vertices: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint16Array; jointIndices?: Float32Array; jointWeights?: Float32Array }) {
        if (!this.gl) return;
        const gl = this.gl;

        if (this.meshes.has(id)) {
            const old = this.meshes.get(id)!;
            gl.deleteVertexArray(old.vao);
        }

        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);

        const createBuffer = (data: Float32Array | Uint16Array, type: number, location: number, size: number, isInt = false) => {
            const buffer = gl.createBuffer()!;
            gl.bindBuffer(type, buffer);
            gl.bufferData(type, data, gl.STATIC_DRAW);
            if (type === gl.ARRAY_BUFFER) {
                if (isInt) gl.vertexAttribIPointer(location, size, gl.INT, 0, 0);
                else gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
                gl.enableVertexAttribArray(location);
            }
            return buffer;
        };

        createBuffer(geometry.vertices, gl.ARRAY_BUFFER, 0, 3);
        createBuffer(geometry.normals, gl.ARRAY_BUFFER, 1, 3);
        createBuffer(geometry.uvs, gl.ARRAY_BUFFER, 8, 2);
        
        if (geometry.jointIndices && geometry.jointWeights) {
             createBuffer(geometry.jointIndices, gl.ARRAY_BUFFER, 11, 4);
             createBuffer(geometry.jointWeights, gl.ARRAY_BUFFER, 12, 4);
        } else {
             gl.disableVertexAttribArray(11);
             gl.disableVertexAttribArray(12);
        }

        const ibo = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);

        const instanceBuffer = gl.createBuffer()!;
        
        gl.bindVertexArray(null);

        this.meshes.set(id, {
            vao,
            count: geometry.indices.length,
            instanceBuffer,
            cpuBuffer: new Float32Array(0),
            instanceCount: 0,
            hasSkin: !!(geometry.jointIndices && geometry.jointWeights)
        });
    }

    updateMaterial(id: number, source: { vs: string; fs: string }) {
        if (!this.gl) return;
        const program = this.createProgram(this.gl, source.vs, source.fs);
        if (program) {
            if (this.materialPrograms.has(id)) this.gl.deleteProgram(this.materialPrograms.get(id)!);
            this.materialPrograms.set(id, program);
        }
    }

    render(store: ComponentStorage, count: number, selectedIndices: Set<number>, viewProj: Float32Array, width: number, height: number, camPos: {x:number, y:number, z:number}, debugRenderer?: DebugRenderer) {
        if (!this.gl) return;
        const gl = this.gl;
        
        // 1. Reset Stats at start of frame
        this.drawCalls = 0;
        this.triangleCount = 0;

        // 2. Fix Feedback Loop by unbinding textures from all units that might be used
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboIncluded);
        gl.viewport(0, 0, this.fboWidth, this.fboHeight);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        this.buckets.clear();
        this.excludedBuckets.clear();

        for (let i = 0; i < count; i++) {
            if (store.isActive[i] && (store.componentMask[i] & COMPONENT_MASKS.MESH)) {
                const meshId = store.meshType[i];
                if (meshId === 0) continue;
                if (!this.buckets.has(meshId)) this.buckets.set(meshId, []);
                this.buckets.get(meshId)!.push(i);
            }
        }

        this.buckets.forEach((indices, meshId) => {
            const batch = this.meshes.get(meshId);
            if (!batch) return;

            const strideFloats = 22;
            const requiredSize = indices.length * strideFloats;
            if (batch.cpuBuffer.length < requiredSize) {
                batch.cpuBuffer = new Float32Array(requiredSize);
            }

            let offset = 0;
            let currentMatId = -1; 
            if (indices.length > 0) currentMatId = store.materialIndex[indices[0]];

            const program = this.materialPrograms.get(currentMatId) || this.defaultProgram;
            if (!program) return;

            gl.useProgram(program);
            
            const u_vp = gl.getUniformLocation(program, 'u_viewProjection');
            const u_time = gl.getUniformLocation(program, 'u_time');
            const u_camPos = gl.getUniformLocation(program, 'u_cameraPos');
            
            gl.uniformMatrix4fv(u_vp, false, viewProj);
            gl.uniform1f(u_time, performance.now() / 1000);
            gl.uniform3f(u_camPos, camPos.x, camPos.y, camPos.z);
            gl.uniform3f(gl.getUniformLocation(program, 'u_lightDir'), 0.5, -1.0, 0.5);
            gl.uniform3f(gl.getUniformLocation(program, 'u_lightColor'), 1, 1, 1);
            gl.uniform1f(gl.getUniformLocation(program, 'u_lightIntensity'), 1.0);
            gl.uniform1i(gl.getUniformLocation(program, 'u_renderMode'), this.renderMode);
            gl.uniform1i(gl.getUniformLocation(program, 'u_hasSkinning'), batch.hasSkin ? 1 : 0);
            gl.uniform1i(gl.getUniformLocation(program, 'u_selectedBoneIndex'), this.selectedBoneIndex);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
            gl.uniform1i(gl.getUniformLocation(program, 'u_textures'), 0);

            if (batch.hasSkin && this.boneTexture) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
                gl.uniform1i(gl.getUniformLocation(program, 'u_boneTexture'), 1);
            }

            for (let i = 0; i < indices.length; i++) {
                const idx = indices[i];
                const base = idx * 16;
                
                for(let k=0; k<16; k++) batch.cpuBuffer[offset++] = store.worldMatrix[base+k];
                
                batch.cpuBuffer[offset++] = store.colorR[idx];
                batch.cpuBuffer[offset++] = store.colorG[idx];
                batch.cpuBuffer[offset++] = store.colorB[idx];
                
                batch.cpuBuffer[offset++] = selectedIndices.has(idx) ? 1.0 : 0.0;
                batch.cpuBuffer[offset++] = store.textureIndex[idx];
                batch.cpuBuffer[offset++] = store.effectIndex[idx];
            }

            gl.bindVertexArray(batch.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, batch.instanceBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, batch.cpuBuffer.subarray(0, offset), gl.DYNAMIC_DRAW);

            const bytesPerFloat = 4;
            const stride = strideFloats * bytesPerFloat;
            
            for (let i = 0; i < 4; i++) {
                gl.enableVertexAttribArray(2 + i);
                gl.vertexAttribPointer(2 + i, 4, gl.FLOAT, false, stride, i * 16);
                gl.vertexAttribDivisor(2 + i, 1);
            }
            gl.enableVertexAttribArray(6);
            gl.vertexAttribPointer(6, 3, gl.FLOAT, false, stride, 16 * 4);
            gl.vertexAttribDivisor(6, 1);
            
            gl.enableVertexAttribArray(7);
            gl.vertexAttribPointer(7, 1, gl.FLOAT, false, stride, 16 * 4 + 12);
            gl.vertexAttribDivisor(7, 1);

            gl.enableVertexAttribArray(9);
            gl.vertexAttribPointer(9, 1, gl.FLOAT, false, stride, 16 * 4 + 16);
            gl.vertexAttribDivisor(9, 1);

            gl.enableVertexAttribArray(10);
            gl.vertexAttribPointer(10, 1, gl.FLOAT, false, stride, 16 * 4 + 20);
            gl.vertexAttribDivisor(10, 1);

            gl.drawElementsInstanced(gl.TRIANGLES, batch.count, gl.UNSIGNED_SHORT, 0, indices.length);
            gl.bindVertexArray(null);
            
            this.drawCalls++;
            this.triangleCount += (batch.count / 3) * indices.length;
        });

        if (this.showGrid && this.gridProgram) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(this.gridProgram);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.gridProgram, 'u_viewProjection'), false, viewProj);
            gl.uniform3fv(gl.getUniformLocation(this.gridProgram, 'u_gridColor'), this.gridColor);
            gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_opacity'), this.gridOpacity);
            gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_gridSize'), this.gridSize);
            gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_subdivisions'), this.gridSubdivisions);
            gl.uniform1f(gl.getUniformLocation(this.gridProgram, 'u_fadeDist'), this.gridFadeDistance);
            
            if (!this.quadVAO) this.initPostProcess(gl); 
            gl.bindVertexArray(this.quadVAO);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindVertexArray(null);
            gl.disable(gl.BLEND);
        }

        if (debugRenderer) {
            debugRenderer.render(viewProj);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.ppProgram);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texColorIncluded);
        gl.uniform1i(gl.getUniformLocation(this.ppProgram, 'u_scene'), 0);
        
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texDataIncluded);
        gl.uniform1i(gl.getUniformLocation(this.ppProgram, 'u_data'), 1);
        
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texColorExcluded);
        gl.uniform1i(gl.getUniformLocation(this.ppProgram, 'u_excluded'), 2);

        gl.uniform1f(gl.getUniformLocation(this.ppProgram, 'u_enabled'), this.ppConfig.enabled ? 1.0 : 0.0);
        gl.uniform1f(gl.getUniformLocation(this.ppProgram, 'u_vignetteStrength'), this.ppConfig.vignetteStrength);
        gl.uniform1f(gl.getUniformLocation(this.ppProgram, 'u_aberrationStrength'), this.ppConfig.aberrationStrength);
        gl.uniform1f(gl.getUniformLocation(this.ppProgram, 'u_toneMapping'), this.ppConfig.toneMapping ? 1.0 : 0.0);
        gl.uniform1f(gl.getUniformLocation(this.ppProgram, 'u_time'), performance.now() / 1000);

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    renderGizmos(viewProj: Float32Array, position: {x:number, y:number, z:number}, scale: number, hoverAxis: string, activeAxis: string) {
        // Placeholder implementation for gizmo rendering
        // In a complete implementation, this would draw 3 axes lines/cones at 'position'
        // For now, we rely on debugRenderer for lines, this hook allows future expansion for custom gizmo meshes
    }
}
