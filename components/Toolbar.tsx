
import React, { useContext } from 'react';
import { Icon } from './Icon';
import { ToolType, TransformSpace } from '../types';
import { EditorContext } from '../contexts/EditorContext';

interface ToolbarProps {
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  currentTool: ToolType;
  setTool: (t: ToolType) => void;
  transformSpace: TransformSpace;
  setTransformSpace: (t: TransformSpace) => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({ 
  isPlaying, onPlay, onPause, onStop, currentTool, setTool,
  transformSpace, setTransformSpace
}) => {
  const ctx = useContext(EditorContext);
  // Default values if context is missing during init/reload
  const snapSettings = ctx?.snapSettings || { active: false, move: 0.5, rotate: 15, scale: 0.1 };
  const setSnapSettings = ctx?.setSnapSettings || (() => {});
  
  const toolClass = (active: boolean) => 
    `p-1.5 rounded-md transition-all ${active ? 'bg-accent text-white shadow-sm' : 'text-text-secondary hover:text-white hover:bg-white/10'}`;

  return (
    <div className="h-10 bg-panel-header border-b border-black/20 flex items-center justify-between px-4 select-none shrink-0 shadow-sm z-10">
      
      {/* Left: Tools */}
      <div className="flex items-center gap-4">
        <div className="flex bg-black/20 p-1 rounded-lg gap-0.5">
          <button className={toolClass(currentTool === 'SELECT')} onClick={() => setTool('SELECT')} title="Select (Q)">
            <Icon name="MousePointer2" size={16} />
          </button>
          <button className={toolClass(currentTool === 'MOVE')} onClick={() => setTool('MOVE')} title="Move (W)">
            <Icon name="Move" size={16} />
          </button>
          <button className={toolClass(currentTool === 'ROTATE')} onClick={() => setTool('ROTATE')} title="Rotate (E)">
            <Icon name="RotateCw" size={16} />
          </button>
          <button className={toolClass(currentTool === 'SCALE')} onClick={() => setTool('SCALE')} title="Scale (R)">
            <Icon name="Maximize" size={16} />
          </button>
        </div>

        <div className="h-5 w-px bg-white/10 mx-2"></div>
        
        <div className="flex gap-2 text-text-secondary text-xs font-medium">
            <button 
                className={`flex items-center gap-1 transition-colors p-1 rounded hover:bg-white/5 ${snapSettings.active ? 'text-accent' : 'text-text-secondary'}`}
                onClick={() => setSnapSettings({ ...snapSettings, active: !snapSettings.active })}
                title="Toggle Snapping"
            >
                <Icon name="Magnet" size={14} className={snapSettings.active ? "fill-current" : ""}/> <span>Snap</span>
            </button>
            
            <button 
                className={`flex items-center gap-1 transition-colors p-1 rounded hover:bg-white/5 ${transformSpace === 'Local' ? 'text-white' : 'text-text-secondary'}`}
                onClick={() => setTransformSpace(transformSpace === 'World' ? 'Local' : 'World')}
                title={`Current Axis: ${transformSpace}`}
            >
                <Icon name={transformSpace === 'World' ? 'Globe' : 'Box'} size={14}/> 
                <span>{transformSpace}</span>
            </button>
        </div>
      </div>

      {/* Center: Playback */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="flex items-center bg-black/40 rounded-md p-1 gap-1 border border-white/5 shadow-inner">
          {!isPlaying ? (
            <button onClick={onPlay} className="p-1 px-3 rounded hover:bg-white/10 text-emerald-500 transition-colors" title="Play Game">
              <Icon name="Play" size={16} className="fill-current" />
            </button>
          ) : (
             <button onClick={onPause} className="p-1 px-3 rounded hover:bg-white/10 text-amber-500 transition-colors" title="Pause Game">
              <Icon name="Pause" size={16} className="fill-current" />
            </button>
          )}
          <button onClick={onStop} className="p-1 px-3 rounded hover:bg-white/10 text-rose-500 transition-colors" title="Stop Game">
            <Icon name="Square" size={16} className="fill-current" />
          </button>
        </div>
      </div>

      {/* Right: Account */}
      <div className="flex items-center gap-3">
        <button className="flex items-center gap-2 text-text-secondary hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-colors">
          <div className="w-5 h-5 bg-indigo-500 rounded-full flex items-center justify-center text-[10px] text-white font-bold ring-2 ring-indigo-500/20">T</div>
          <span className="text-xs font-medium">Team</span>
        </button>
      </div>
    </div>
  );
};
