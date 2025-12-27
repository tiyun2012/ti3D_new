
import React, { useState, useEffect, useRef, useContext, useLayoutEffect } from 'react';
import { Icon } from './Icon';
import { engineInstance } from '../services/engine';

export const Timeline: React.FC = () => {
    const [timeline, setTimeline] = useState(engineInstance.timeline);
    const rulerRef = useRef<HTMLDivElement>(null);
    const [isScrubbing, setIsScrubbing] = useState(false);
    // Added rulerWidth state to track the actual size of the timeline track area
    const [rulerWidth, setRulerWidth] = useState(0);

    // Track the width of the ruler area to accurately position the playhead
    useLayoutEffect(() => {
        if (!rulerRef.current) return;
        const observer = new ResizeObserver(entries => {
            if (entries[0].contentRect.width > 0) {
                setRulerWidth(entries[0].contentRect.width);
            }
        });
        observer.observe(rulerRef.current);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const update = () => {
            setTimeline({ ...engineInstance.timeline });
        };
        const unsub = engineInstance.subscribe(update);
        return unsub;
    }, []);

    const handleScrub = (e: React.MouseEvent | React.TouchEvent) => {
        if (!rulerRef.current) return;
        const rect = rulerRef.current.getBoundingClientRect();
        const clientX = 'touches' in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        const percentage = x / rect.width;
        engineInstance.setTimelineTime(percentage * timeline.duration);
    };

    const onMouseDown = (e: React.MouseEvent) => {
        setIsScrubbing(true);
        handleScrub(e);
    };

    useEffect(() => {
        if (!isScrubbing) return;
        const onMouseMove = (e: MouseEvent) => handleScrub(e as any);
        const onMouseUp = () => setIsScrubbing(false);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [isScrubbing]);

    const formatTime = (time: number) => {
        const mins = Math.floor(time / 60);
        const secs = Math.floor(time % 60);
        const ms = Math.floor((time % 1) * 100);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
    };

    const renderRuler = () => {
        const ticks = [];
        const seconds = Math.floor(timeline.duration);
        for (let i = 0; i <= seconds; i++) {
            ticks.push(
                <div key={i} className="absolute h-full flex flex-col items-center" style={{ left: `${(i / timeline.duration) * 100}%` }}>
                    <div className="w-px h-2 bg-white/20"></div>
                    <span className="text-[8px] mt-0.5 opacity-40 select-none">{i}s</span>
                </div>
            );
        }
        return ticks;
    };

    return (
        <div className="h-full flex flex-col bg-[#1a1a1a] font-sans border-t border-black/40">
            {/* Header / Transport */}
            <div className="h-10 bg-panel-header flex items-center px-4 justify-between border-b border-white/5">
                <div className="flex items-center gap-4">
                    <div className="flex items-center bg-black/40 rounded p-0.5 gap-0.5 border border-white/5">
                        <button 
                            onClick={() => engineInstance.setTimelineTime(0)} 
                            className="p-1 hover:bg-white/10 rounded text-text-secondary hover:text-white transition-colors"
                            title="Rewind to Start"
                        >
                            <Icon name="SkipBack" size={14} />
                        </button>
                        <button 
                            onClick={() => timeline.isPlaying ? engineInstance.pause() : engineInstance.start()} 
                            className={`p-1 px-3 rounded transition-all ${timeline.isPlaying ? 'text-amber-500 bg-amber-500/10' : 'text-emerald-500 hover:bg-emerald-500/10'}`}
                            title={timeline.isPlaying ? "Pause" : "Play"}
                        >
                            <Icon name={timeline.isPlaying ? "Pause" : "Play"} size={16} className="fill-current" />
                        </button>
                        <button 
                            onClick={() => engineInstance.stop()} 
                            className="p-1 hover:bg-rose-500/10 rounded text-rose-500 transition-colors"
                            title="Stop & Reset"
                        >
                            <Icon name="Square" size={14} className="fill-current" />
                        </button>
                    </div>

                    <div className="flex items-center gap-2 bg-black/30 px-3 py-1 rounded border border-white/5 font-mono text-accent">
                        <Icon name="Clock" size={12} className="opacity-50" />
                        <span className="text-[11px] font-bold">{formatTime(timeline.currentTime)}</span>
                    </div>
                </div>

                <div className="flex items-center gap-3 text-text-secondary text-[10px] font-bold">
                    <div className="flex items-center gap-1 opacity-60">
                        <Icon name="Repeat" size={12} className={timeline.isLooping ? "text-accent" : ""} />
                        <span>Loop</span>
                        <input 
                            type="checkbox" 
                            checked={timeline.isLooping} 
                            onChange={(e) => { engineInstance.timeline.isLooping = e.target.checked; engineInstance.notifyUI(); }} 
                            className="ml-1 w-3 h-3 accent-accent"
                            aria-label="Toggle Looping"
                        />
                    </div>
                    <div className="w-px h-4 bg-white/10"></div>
                    <span className="opacity-40">DUR: {timeline.duration}s</span>
                </div>
            </div>

            {/* Scrub Area */}
            <div className="flex-1 flex flex-col p-4 bg-black/10 relative group">
                <div 
                    ref={rulerRef} 
                    className="relative h-8 bg-black/40 rounded-t border-x border-t border-white/5 cursor-pointer overflow-hidden"
                    onMouseDown={onMouseDown}
                >
                    {/* Tick Marks */}
                    {renderRuler()}

                    {/* Progress Highlight */}
                    <div 
                        className="absolute inset-y-0 left-0 bg-accent/5 border-r border-accent/20 transition-all duration-75 pointer-events-none"
                        style={{ width: `${(timeline.currentTime / timeline.duration) * 100}%` }}
                    />
                </div>

                <div className="flex-1 bg-black/20 rounded-b border border-white/5 relative overflow-hidden">
                     {/* Horizontal grid lines for tracks */}
                     <div className="absolute inset-0 opacity-10 pointer-events-none" 
                          style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px)', backgroundSize: '100% 24px' }} />
                     
                     <div className="p-2 space-y-1">
                        <div className="flex items-center gap-2 text-[9px] text-text-secondary uppercase font-bold tracking-tighter opacity-40">
                             <Icon name="Activity" size={10} /> Master Sequence
                        </div>
                     </div>
                </div>

                {/* Playhead */}
                <div 
                    className="absolute top-4 bottom-4 w-px bg-white z-10 pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                    style={{ 
                        // Fix: Replaced missing viewportSize with rulerWidth tracking
                        left: `calc(1rem + ${(timeline.currentTime / timeline.duration) * rulerWidth}px)`, 
                        transform: 'translateX(-50%)' 
                    }}
                >
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-white rotate-45 rounded-sm"></div>
                </div>
            </div>
        </div>
    );
};
