
export class DebugRenderer {
    gl: WebGL2RenderingContext | null = null;
    program: WebGLProgram | null = null;
    
    // Lines
    maxLines = 150000; 
    lineBufferData = new Float32Array(this.maxLines * 12); 
    lineCount = 0;
    lineVAO: WebGLVertexArrayObject | null = null;
    lineVBO: WebGLBuffer | null = null;

    // Points
    maxPoints = 100000;
    pointBufferData = new Float32Array(this.maxPoints * 7); // x, y, z, r, g, b, size
    pointCount = 0;
    pointVAO: WebGLVertexArrayObject | null = null;
    pointVBO: WebGLBuffer | null = null;

    uniforms: { u_vp: WebGLUniformLocation | null } = { u_vp: null };

    init(gl: WebGL2RenderingContext) {
        if (!gl) return;
        this.gl = gl;
        
        // Updated Shader to support Point Size
        const vs = `#version 300 es
        layout(location=0) in vec3 a_pos; 
        layout(location=1) in vec3 a_color; 
        layout(location=2) in float a_size; 
        uniform mat4 u_vp; 
        out vec3 v_color; 
        void main() { 
            gl_Position = u_vp * vec4(a_pos, 1.0); 
            v_color = a_color; 
            gl_PointSize = a_size;
        }`;
        const fs = `#version 300 es
        precision mediump float; 
        in vec3 v_color; 
        out vec4 color; 
        void main() { color = vec4(v_color, 1.0); }`;
        
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
        
        // Init Line VAO
        this.lineVAO = gl.createVertexArray(); this.lineVBO = gl.createBuffer();
        gl.bindVertexArray(this.lineVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
        gl.bufferData(gl.ARRAY_BUFFER, this.lineBufferData.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0); 
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        // Attribute 2 (size) is disabled for lines, defaults to 0/undefined
        gl.bindVertexArray(null);

        // Init Point VAO
        this.pointVAO = gl.createVertexArray(); this.pointVBO = gl.createBuffer();
        gl.bindVertexArray(this.pointVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO);
        gl.bufferData(gl.ARRAY_BUFFER, this.pointBufferData.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0); 
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24); // Size
        gl.bindVertexArray(null);
    }

    begin() { 
        this.lineCount = 0; 
        this.pointCount = 0;
    }

    drawLine(p1: {x:number, y:number, z:number}, p2: {x:number, y:number, z:number}, color: {r:number, g:number, b:number}) {
        if (this.lineCount >= this.maxLines) return;
        const i = this.lineCount * 12;
        this.lineBufferData[i] = p1.x; this.lineBufferData[i+1] = p1.y; this.lineBufferData[i+2] = p1.z;
        this.lineBufferData[i+3] = color.r; this.lineBufferData[i+4] = color.g; this.lineBufferData[i+5] = color.b;
        this.lineBufferData[i+6] = p2.x; this.lineBufferData[i+7] = p2.y; this.lineBufferData[i+8] = p2.z;
        this.lineBufferData[i+9] = color.r; this.lineBufferData[i+10] = color.g; this.lineBufferData[i+11] = color.b;
        this.lineCount++;
    }

    drawPoint(p: {x:number, y:number, z:number}, color: {r:number, g:number, b:number}, size: number) {
        if (this.pointCount >= this.maxPoints) return;
        const i = this.pointCount * 7;
        this.pointBufferData[i] = p.x;   this.pointBufferData[i+1] = p.y;   this.pointBufferData[i+2] = p.z;
        this.pointBufferData[i+3] = color.r; this.pointBufferData[i+4] = color.g; this.pointBufferData[i+5] = color.b;
        this.pointBufferData[i+6] = size;
        this.pointCount++;
    }

    render(viewProjection: Float32Array) {
        if (!this.gl || !this.program) return;
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uniforms.u_vp, false, viewProjection);
        
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        // Render Lines
        if (this.lineCount > 0 && this.lineVAO) {
            gl.bindVertexArray(this.lineVAO);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineBufferData.subarray(0, this.lineCount * 12));
            gl.drawArrays(gl.LINES, 0, this.lineCount * 2);
        }

        // Render Points
        if (this.pointCount > 0 && this.pointVAO) {
            gl.bindVertexArray(this.pointVAO);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointBufferData.subarray(0, this.pointCount * 7));
            gl.drawArrays(gl.POINTS, 0, this.pointCount);
        }

        gl.bindVertexArray(null);
    }
}
