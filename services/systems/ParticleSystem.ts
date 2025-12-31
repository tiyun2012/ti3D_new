
import { ComponentStorage } from '../ecs/ComponentStorage';
import { COMPONENT_MASKS } from '../constants';
import { Vec3Utils, Random } from '../math';

const PARTICLE_VS = `#version 300 es
layout(location=0) in vec3 a_center;
layout(location=1) in vec3 a_color;
layout(location=2) in float a_size;
layout(location=3) in float a_life; // 0..1 (1=birth, 0=death)
layout(location=4) in float a_texIndex;
layout(location=5) in float a_effectIndex;

uniform mat4 u_viewProjection;
uniform vec3 u_cameraPos;
uniform vec3 u_cameraUp;

out vec3 v_color;
out vec2 v_uv;
out float v_life;
out float v_texIndex;
out float v_effectIndex;

void main() {
    // Billboarding logic
    vec3 toCam = normalize(u_cameraPos - a_center);
    vec3 right = normalize(cross(u_cameraUp, toCam));
    vec3 up = cross(toCam, right);
    
    // Quad expansion (indices: 0,1,2, 0,2,3 for 4 verts)
    // Vert ID derived from gl_VertexID 0..3
    int id = gl_VertexID % 4;
    vec2 offset = vec2(0.0);
    if(id == 0) offset = vec2(-0.5, -0.5);
    else if(id == 1) offset = vec2(0.5, -0.5);
    else if(id == 2) offset = vec2(0.5, 0.5);
    else if(id == 3) offset = vec2(-0.5, 0.5);
    
    vec3 pos = a_center + (right * offset.x + up * offset.y) * a_size;
    
    v_uv = offset + 0.5;
    v_color = a_color;
    v_life = a_life;
    v_texIndex = a_texIndex;
    v_effectIndex = a_effectIndex;
    
    gl_Position = u_viewProjection * vec4(pos, 1.0);
}`;

const PARTICLE_FS = `#version 300 es
precision mediump float;
precision mediump sampler2DArray;

in vec3 v_color;
in vec2 v_uv;
in float v_life;
in float v_texIndex;
in float v_effectIndex;

uniform sampler2DArray u_textures;

layout(location=0) out vec4 outColor;
layout(location=1) out vec4 outData;

void main() {
    vec4 texColor = vec4(1.0);
    if (v_texIndex > 0.5) {
        texColor = texture(u_textures, vec3(v_uv, v_texIndex));
    } else {
        // Default soft circle
        float d = length(v_uv - 0.5) * 2.0;
        float a = 1.0 - smoothstep(0.8, 1.0, d);
        texColor = vec4(1.0, 1.0, 1.0, a);
    }
    
    // Fade out over life
    float alpha = texColor.a * v_life;
    if (alpha < 0.01) discard;
    
    vec3 finalColor = v_color * texColor.rgb;
    
    // Stylized Threshold (Toon) for fire/smoke
    // if (v_effectIndex > 0.0) {
    //     float brightness = max(finalColor.r, max(finalColor.g, finalColor.b));
    //     if (brightness > 0.5) finalColor += 0.2;
    // }

    outColor = vec4(finalColor, alpha);
    outData = vec4(v_effectIndex / 255.0, 0.0, 0.0, 1.0);
}`;

// CPU Particle Data
interface Particle {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    life: number;
    maxLife: number;
    size: number;
    color: { r: number, g: number, b: number };
}

// Each Entity has one Emitter instance
class EmitterInstance {
    particles: Particle[] = [];
    spawnAccumulator = 0;
    
    // Buffer Data (rebuilt every frame)
    bufferData: Float32Array;
    
    constructor(maxCount: number) {
        this.bufferData = new Float32Array(Math.min(maxCount, 20000) * 10); // stride 10
    }
}

export class ParticleSystem {
    gl: WebGL2RenderingContext | null = null;
    program: WebGLProgram | null = null;
    emitters: Map<number, EmitterInstance> = new Map();
    
    vao: WebGLVertexArrayObject | null = null;
    vbo: WebGLBuffer | null = null;
    
    // Max particles per draw call batch (matches VBO size)
    MAX_BATCH = 10000;

    uniforms: {
        viewProjection: WebGLUniformLocation | null;
        cameraPos: WebGLUniformLocation | null;
        cameraUp: WebGLUniformLocation | null;
        textures: WebGLUniformLocation | null;
    } = { viewProjection: null, cameraPos: null, cameraUp: null, textures: null };
    
    init(gl: WebGL2RenderingContext) {
        this.gl = gl;
        
        const vs = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vs, PARTICLE_VS); gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vs));

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fs, PARTICLE_FS); gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fs));

        this.program = gl.createProgram()!; gl.attachShader(this.program, vs); gl.attachShader(this.program, fs); gl.linkProgram(this.program);
        
        // Cache Uniforms
        this.uniforms.viewProjection = gl.getUniformLocation(this.program, 'u_viewProjection');
        this.uniforms.cameraPos = gl.getUniformLocation(this.program, 'u_cameraPos');
        this.uniforms.cameraUp = gl.getUniformLocation(this.program, 'u_cameraUp');
        this.uniforms.textures = gl.getUniformLocation(this.program, 'u_textures');

        this.vao = gl.createVertexArray();
        this.vbo = gl.createBuffer();
        
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.MAX_BATCH * 10 * 4, gl.DYNAMIC_DRAW);
        
        // Attrs: Center(3), Color(3), Size(1), Life(1), Tex(1), Effect(1) -> 10 floats
        const stride = 10 * 4;
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0); // Center
        gl.vertexAttribDivisor(0, 1);
        
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12); // Color
        gl.vertexAttribDivisor(1, 1);
        
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24); // Size
        gl.vertexAttribDivisor(2, 1);
        
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28); // Life
        gl.vertexAttribDivisor(3, 1);
        
        gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32); // Tex
        gl.vertexAttribDivisor(4, 1);
        
        gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 36); // Effect
        gl.vertexAttribDivisor(5, 1);
        
        gl.bindVertexArray(null);
    }

    update(dt: number, store: ComponentStorage) {
        // Safe Delta Time to prevent simulation explosions on tab resume
        const safeDt = Math.min(dt, 0.1);

        for (let i = 0; i < store.capacity; i++) {
            if (!store.isActive[i] || !(store.componentMask[i] & COMPONENT_MASKS.PARTICLE_SYSTEM)) {
                if (this.emitters.has(i)) this.emitters.delete(i); // Cleanup
                continue;
            }

            let emitter = this.emitters.get(i);
            const maxCount = store.psMaxCount[i];
            
            if (!emitter || emitter.particles.length > maxCount + 100) { // Re-init if config changed significantly
                emitter = new EmitterInstance(maxCount);
                this.emitters.set(i, emitter);
            }

            // --- SIMULATION ---
            
            // 1. Spawning
            emitter.spawnAccumulator += safeDt * store.psRate[i];
            const spawnCount = Math.floor(emitter.spawnAccumulator);
            emitter.spawnAccumulator -= spawnCount;
            
            // Cap emission per frame to avoid freeze
            const actualSpawn = Math.min(spawnCount, 100);

            const shape = store.psShape[i];
            const wmOffset = i * 16;
            const rootPos = { x: store.worldMatrix[wmOffset+12], y: store.worldMatrix[wmOffset+13], z: store.worldMatrix[wmOffset+14] };
            const speed = store.psSpeed[i];
            
            for (let k = 0; k < actualSpawn; k++) {
                if (emitter.particles.length >= maxCount) break;
                
                let vx=0, vy=1, vz=0;
                let px=rootPos.x, py=rootPos.y, pz=rootPos.z;
                
                // Shape Logic
                if (shape === 1) { // Cone
                    const theta = Math.random() * Math.PI * 2;
                    const spread = 0.5; // Fixed spread for now
                    vx = (Math.random() - 0.5) * spread;
                    vz = (Math.random() - 0.5) * spread;
                    vy = 1.0;
                } else if (shape === 2) { // Sphere
                    Random.onSphere(1, {x:0,y:0,z:0}); 
                    // Quick sphere random
                    const phi = Math.random() * Math.PI * 2;
                    const costheta = Math.random() * 2 - 1;
                    const rho = Math.sqrt(1 - costheta * costheta);
                    vx = rho * Math.cos(phi);
                    vy = rho * Math.sin(phi);
                    vz = costheta;
                }
                
                // Normalize velocity
                const len = Math.sqrt(vx*vx+vy*vy+vz*vz);
                if (len > 0) { vx/=len; vy/=len; vz/=len; }
                
                emitter.particles.push({
                    x: px, y: py, z: pz,
                    vx: vx * speed, vy: vy * speed, vz: vz * speed,
                    life: store.psLife[i], maxLife: store.psLife[i],
                    size: store.psSize[i] * (0.5 + Math.random()*0.5),
                    color: { r: store.psColorR[i], g: store.psColorG[i], b: store.psColorB[i] }
                });
            }

            // 2. Integration
            for (let pIdx = emitter.particles.length - 1; pIdx >= 0; pIdx--) {
                const p = emitter.particles[pIdx];
                p.life -= safeDt;
                if (p.life <= 0) {
                    // Fast remove
                    emitter.particles[pIdx] = emitter.particles[emitter.particles.length - 1];
                    emitter.particles.pop();
                    continue;
                }
                
                p.x += p.vx * safeDt;
                p.y += p.vy * safeDt;
                p.z += p.vz * safeDt;
                
                // Physics: Buoyancy & Drag
                p.vy += 0.5 * safeDt; 
                p.vx *= 0.99;
                p.vy *= 0.99;
                p.vz *= 0.99;
            }
        }
    }

    render(viewProj: Float32Array, camPos: {x:number, y:number, z:number}, textureArray: WebGLTexture | null) {
        if (!this.gl || !this.program || !this.vao) return;
        const gl = this.gl;
        
        gl.useProgram(this.program);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive usually looks better for fire/magic
        gl.depthMask(false); 
        
        // Use Cached Uniforms
        gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProj);
        gl.uniform3f(this.uniforms.cameraPos, camPos.x, camPos.y, camPos.z);
        gl.uniform3f(this.uniforms.cameraUp, 0, 1, 0); // Approx
        
        if (textureArray) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, textureArray);
            gl.uniform1i(this.uniforms.textures, 0);
        }

        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

        const store = (window as any).engineInstance.ecs.store;

        this.emitters.forEach((emitter, idx) => {
            if (emitter.particles.length === 0) return;
            
            const texIdx = store.psTextureId[idx];
            const effectIdx = store.effectIndex[idx];
            
            // Rebuild Buffer (CPU -> GPU streaming)
            // Clamp to MAX_BATCH to prevent buffer overflow
            const count = Math.min(emitter.particles.length, this.MAX_BATCH);
            
            if (emitter.bufferData.length < count * 10) {
                emitter.bufferData = new Float32Array(Math.max(count * 10, 4096));
            }
            
            const data = emitter.bufferData;
            let ptr = 0;
            
            for(let i = 0; i < count; i++) {
                const p = emitter.particles[i];
                data[ptr++] = p.x;
                data[ptr++] = p.y;
                data[ptr++] = p.z;
                data[ptr++] = p.color.r;
                data[ptr++] = p.color.g;
                data[ptr++] = p.color.b;
                // Fade out at end
                const lifeRatio = p.life / p.maxLife;
                data[ptr++] = p.size * Math.sin(lifeRatio * Math.PI); // Grow then shrink
                data[ptr++] = lifeRatio;
                data[ptr++] = texIdx;
                data[ptr++] = effectIdx;
            }
            
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, ptr));
            
            // Draw Instanced Quads
            gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, count);
        });

        gl.bindVertexArray(null);
        gl.depthMask(true);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
}
