
import { EngineModule, ModuleContext } from '../types';

class ModuleManagerService {
    private modules: Map<string, EngineModule> = new Map();
    private context: ModuleContext | null = null;

    init(context: ModuleContext) {
        this.context = context;
        // Re-register any modules added before engine init
        this.modules.forEach(m => {
            if (m.onRegister) m.onRegister(context);
        });
    }

    register(module: EngineModule) {
        if (this.modules.has(module.id)) {
            console.warn(`Module ${module.id} already registered. Overwriting.`);
        }
        this.modules.set(module.id, module);
        
        if (this.context && module.onRegister) {
            module.onRegister(this.context);
        }
    }

    getModule(id: string) {
        return this.modules.get(id);
    }

    getAllModules() {
        return Array.from(this.modules.values()).sort((a, b) => a.order - b.order);
    }

    // Called by Engine loop
    update(dt: number) {
        if (!this.context) return;
        this.modules.forEach(m => {
            if (m.onUpdate) m.onUpdate(dt, this.context!);
        });
    }

    // Called by Renderer
    render(gl: WebGL2RenderingContext, viewProj: Float32Array) {
        if (!this.context) return;
        this.modules.forEach(m => {
            if (m.onRender) m.onRender(gl, viewProj, this.context!);
        });
    }
}

export const moduleManager = new ModuleManagerService();
