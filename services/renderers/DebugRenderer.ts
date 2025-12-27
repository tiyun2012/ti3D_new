
export class DebugRenderer {
    gl: WebGL2RenderingContext | null = null;
    program: WebGLProgram | null = null;
    maxLines = 150000; 
    lineBufferData = new Float32Array(this.maxLines * 12); 
    lineCount = 0;
    vao: WebGLVertexArrayObject | null = null;
    vbo: WebGLBuffer | null = null;
    uniforms: { u_vp: WebGLUniformLocation | null } = { u_vp: null };

    init(gl: WebGL2RenderingContext) {
        if (!gl) return;
        this.gl = gl;
        const vs = `#version 300 es\nlayout(location=0) in vec3 a_pos; layout(location=1) in vec3 a_color; uniform mat4 u_vp; out vec3 v_color; void main() { gl_Position = u_vp * vec4(a_pos, 1.0); v_color = a_color; }`;
        const fs = `#version 300 es\nprecision mediump float; in vec3 v_color; out vec4 color; void main() { color = vec4(v_color, 1.0); }`;
        const createShader = (type: number, src: string) => {
            const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
            if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
            return s;
        };
        const p = gl.createProgram()!;
        const vShader = createShader(gl.VERTEX_SHADER, vs); const fShader = createShader(gl.FRAGMENT_SHADER, fs);
        if (!vShader || !fShader) return;
        gl.attachShader(p, vShader); gl.attachShader(p, fShader); gl.linkProgram(p);
        this.program = p;
        this.uniforms.u_vp = gl.getUniformLocation(p, 'u_vp');
        this.vao = gl.createVertexArray(); this.vbo = gl.createBuffer();
        gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.lineBufferData.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0); 
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.bindVertexArray(null);
    }

    begin() { this.lineCount = 0; }

    drawLine(p1: {x:number, y:number, z:number}, p2: {x:number, y:number, z:number}, color: {r:number, g:number, b:number}) {
        if (this.lineCount >= this.maxLines) return;
        const i = this.lineCount * 12;
        this.lineBufferData[i] = p1.x; this.lineBufferData[i+1] = p1.y; this.lineBufferData[i+2] = p1.z;
        this.lineBufferData[i+3] = color.r; this.lineBufferData[i+4] = color.g; this.lineBufferData[i+5] = color.b;
        this.lineBufferData[i+6] = p2.x; this.lineBufferData[i+7] = p2.y; this.lineBufferData[i+8] = p2.z;
        this.lineBufferData[i+9] = color.r; this.lineBufferData[i+10] = color.g; this.lineBufferData[i+11] = color.b;
        this.lineCount++;
    }

    render(viewProjection: Float32Array) {
        if (this.lineCount === 0 || !this.gl || !this.program || !this.vao) return;
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uniforms.u_vp, false, viewProjection);
        
        // Depth Test is now preserved to allow the scene to occlude back-edges.
        // Leap of faith: LEQUAL allows lines on surface to draw correctly.
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.lineBufferData.byteLength, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineBufferData.subarray(0, this.lineCount * 12));
        gl.drawArrays(gl.LINES, 0, this.lineCount * 2);
        gl.bindVertexArray(null);
    }
}
