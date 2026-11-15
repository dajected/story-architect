import { useEffect, useState, type CSSProperties } from 'react';
import { Modal } from './ui';

export function useWritingPreferences() {
  const [preferences, setPreferences] = useState(() => {
    if (localStorage.getItem('reading-width-version') !== '1') {const saved = JSON.parse(localStorage.getItem('writing-preferences') ?? '{}'); saved.textWidth = 1200; localStorage.setItem('writing-preferences', JSON.stringify(saved)); localStorage.setItem('reading-width-version', '1');}
    try {return {fontSize: 18, lineHeight: 1.8, textWidth: 1200, sidebarWidth: 258, assistantWidth: 360, ...JSON.parse(localStorage.getItem('writing-preferences') ?? '{}')} as Record<string, number>;} catch {return {fontSize:18,lineHeight:1.8,textWidth:1200,sidebarWidth:258,assistantWidth:360};}
  });
  useEffect(() => {localStorage.setItem('writing-preferences', JSON.stringify(preferences));}, [preferences]);
  const style = Object.fromEntries(Object.entries(preferences).map(([key,value]) => [`--writing-${key}`, key === 'lineHeight' ? String(value) : `${value}px`])) as CSSProperties;
  return {preferences, setPreferences, style};
}

export function WritingPreferences({open, onClose, preferences, onChange}: {open: boolean; onClose: () => void; preferences: Record<string,number>; onChange: (key: string, value: number) => void}) {
  return <Modal open={open} onClose={onClose} title="Writing preferences" subtitle="Display preferences are saved on this device."><WritingPreferencesContent preferences={preferences} onChange={onChange} /></Modal>;
}

export function WritingPreferencesContent({preferences, onChange}: {preferences: Record<string, number>; onChange: (key: string, value: number) => void}) {
  return <div className="stack">{[
    ['fontSize','Prose font size',14,28,1,'px'],['lineHeight','Line spacing',1.3,2.4,.1,'×'],['textWidth','Reading width',600,1600,20,'px'],['sidebarWidth','Chapter panel width',200,400,10,'px'],['assistantWidth','Assistant width',280,600,10,'px'],
  ].map(([key,label,min,max,step,unit]) => <label key={key}> {label}: {Number(preferences[String(key)]).toFixed(key === 'lineHeight' ? 1 : 0)} {unit}<input type="range" min={min} max={max} step={step} value={preferences[String(key)]} onChange={e => onChange(String(key), Number(e.target.value))} /></label>)}<h3>Keyboard shortcuts</h3><p>Ctrl / ⌘ + Shift + F — Focus mode<br />Ctrl / ⌘ + Shift + A — Assistant<br />Alt + ← / → — Previous / next chapter<br />Escape — Leave focus mode or close a dialog</p></div>;
}

export function PanelResize({label, value, min, max, onChange, reverse = false}: {label:string;value:number;min:number;max:number;onChange:(value:number)=>void;reverse?:boolean}) {
  return <div className="panel-resize" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    onKeyDown={e => {if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {e.preventDefault(); onChange(Math.max(min,Math.min(max,value+(e.key==='ArrowRight'?10:-10)*(reverse?-1:1))));}}}
    onPointerDown={e => {const start=e.clientX; const initial=value; e.currentTarget.setPointerCapture(e.pointerId); const move=(event:PointerEvent)=>onChange(Math.max(min,Math.min(max,initial+(event.clientX-start)*(reverse?-1:1)))); const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);}; window.addEventListener('pointermove',move);window.addEventListener('pointerup',end,{once:true});}} />;
}
