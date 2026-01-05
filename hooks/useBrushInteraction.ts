
import { useEffect, useRef, useState, useContext } from 'react';
import { EditorContext } from '../contexts/EditorContext';

export const useBrushInteraction = () => {
    const ctx = useContext(EditorContext);
    
    // Safety check for context usage
    if (!ctx) return { isAdjustingBrush: false, isBrushKeyHeld: { current: false } };

    const { 
        softSelectionEnabled, setSoftSelectionEnabled,
        softSelectionRadius, setSoftSelectionRadius 
    } = ctx;

    const [isAdjustingBrush, setIsAdjustingBrush] = useState(false);
    const bKeyRef = useRef(false);
    const brushStartPos = useRef({ x: 0, y: 0, startRadius: 0 });

    useEffect(() => {
        const onDown = (e: KeyboardEvent) => { if(e.key.toLowerCase() === 'b') bKeyRef.current = true; };
        const onUp = (e: KeyboardEvent) => { if(e.key.toLowerCase() === 'b') bKeyRef.current = false; };
        
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, []);

    useEffect(() => {
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (isAdjustingBrush) {
                const dx = e.clientX - brushStartPos.current.x;
                const sensitivity = 0.05;
                const newRad = Math.max(0.1, brushStartPos.current.startRadius + dx * sensitivity);
                setSoftSelectionRadius(newRad);
            }
        };

        const handleGlobalMouseUp = () => setIsAdjustingBrush(false);

        const onWindowMouseDown = (e: MouseEvent) => {
            if (bKeyRef.current && e.button === 0) {
                // IMPORTANT: Stop propagation to prevent SceneView from handling this click as a selection
                e.preventDefault(); 
                e.stopPropagation();
                
                if (!softSelectionEnabled) setSoftSelectionEnabled(true);
                
                setIsAdjustingBrush(true);
                brushStartPos.current = { x: e.clientX, y: e.clientY, startRadius: softSelectionRadius };
            }
        };

        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        // Use capture to intercept before React components
        window.addEventListener('mousedown', onWindowMouseDown, { capture: true }); 
        
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
            window.removeEventListener('mousedown', onWindowMouseDown, { capture: true });
        };
    }, [isAdjustingBrush, softSelectionEnabled, softSelectionRadius, setSoftSelectionRadius, setSoftSelectionEnabled]);

    return { isAdjustingBrush, isBrushKeyHeld: bKeyRef };
};
