"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { applyGameCommand } from './components/gameInput';
import { AudioPanel } from './components/AudioPanel';
import { useDialogFocusTrap } from './components/focusTrap';
import { DEFAULT_AUDIO_SETTINGS,applyAudioPatch,readAudioSettings,writeAudioSettings,type AudioSettings } from './components/audioSettings';
import { createAudioEngine,type MixerAudioEngine,type SfxId } from '../lib/engine/audio';
import { tensionFor } from '../lib/engine/score';
import {copyCreature, ARENA,FOODS,createArcade,servingsForLevel,inFrenzy,stepArcade,type ArcadeEvent,type ArcadeState,type ArcadeCommand,type Ingredient } from '../lib/game/arcade';
import { DEV_HOOKS,devHookBag } from '../lib/dev/hook';
import { TOKENS,markFor } from '../lib/render/tokens';
import { CAUSES,ENDING_JOKES,HALLOWEEN,HEADLINES,INHERITED,TOKEN_FLIGHT,TOKEN_TRAITS,VERSES,WALLET_TIERS,pressELine,verseAt,type Verse as VerseData } from '../lib/render/lore';
import { Verse } from './components/Verse';
import { seasonFor,type Season } from '../lib/render/season';
import { pressEPhase } from '../lib/render/pressE';
import { communityDiet,communityDietLine } from '../lib/community/diet';
import { DietClose,InheritedLine,Ledger,LastFiling,headerLabel,useChain } from './components/Ledger';
import { TopKeepers } from './components/TopKeepers';
import type { Ticket } from '../lib/chain/api';
import { inheritedOf } from '../lib/chain/types';
/** The three tokens, by the names the legend uses. The rules' keys (metal, balloon, pepper) are not shown. */
const LABELS:Record<Ingredient,string>={metal:TOKENS.metal.name,balloon:TOKENS.balloon.name,pepper:TOKENS.pepper.name};
/** What a level of a token turns it into. The chip and the legend say only this. */
const TRAITS:Record<Ingredient,string>=TOKEN_TRAITS;
/** The coin clink, pitched by token, on a launch and on a catch. On top of the cue, not instead of it. */
function clinkFor(e:ArcadeEvent):SfxId|null{if((e.type==='launch'||e.type==='feed')&&e.ingredient)return `clink-${TOKENS[e.ingredient].id.toLowerCase()}` as SfxId;return null;}
/** The mark for a token, once it has decoded: a URL, null when there is no file (HEMI before the kit lands), undefined while loading. */
function useMark(food:Ingredient){const [src,setSrc]=useState<string|null|undefined>(undefined);useEffect(()=>{let live=true;void markFor(food).then(image=>{if(live)setSrc(image?image.src:null);});return()=>{live=false;};},[food]);return src;}
/**
 * A coin in the DOM: the mark, unmodified, on a round plate in the game's
 * palette (the plate is the span; the mark is the img). When the HEMI file is
 * missing the plate shows the stand-in H instead. Decorative: the text beside
 * it carries the name.
 */
function TokenMark({food}:{food:Ingredient}){const src=useMark(food);
  // A plain img: the marks are small SVGs served as-is, and an optimiser would re-encode them.
  // eslint-disable-next-line @next/next/no-img-element
  const mark=src?<img src={src} alt="" draggable={false}/>:src===null&&food==='pepper'?<b>H</b>:null;
  return <span className={`item-art ${food}`} aria-hidden="true">{mark}</span>;}
/** How many frames the simulation holds after a catch. Pillar 7: the hit-stop. */
const HIT_STOP_FRAMES=3;
/** A shift's end is not a prompt. The hands that fed it are still hammering Space, so the restart (Space, R, the button) arms this long after the result lands. */
const RESTART_LOCK_MS=3000;
/** Which cue an event plays. The renderer draws them; this is the sound. */
function cueFor(e:ArcadeEvent):SfxId|null{
  switch(e.type){
    case 'feed':return 'feed';
    case 'chew':return 'chew';
    case 'launch':return 'launch';
    case 'miss':return 'mistake';
    case 'clank':return 'clank';
    case 'bounce':return e.name==='floor'?null:e.name==='crate'?'wrong-token':'bounce';
    case 'crate':return e.name==='hit'?'block-hit':e.name==='spawn'?'block-in':'block-gone';
    case 'bank':return 'bank';
    case 'frenzy':return e.name==='start'?'frenzy-start':'frenzy-end';
    case 'utensil':return e.name==='caught'?'utensil':null;
    case 'cooked':return 'cooked';
    case 'flame':return e.name==='tell'?'flame-tell':'flame';
    case 'fire':return e.name==='start'?'fire':null;
    case 'jam':return 'jam';
    case 'grow':return 'grow';
    case 'mutation':return 'mutation';
    case 'tantrum':return 'tantrum';
    case 'craving':return e.name==='start'?'craving':null;
    case 'beat':return e.name==='sneeze'?'gust':e.name==='bite'?'jam':null;
    case 'end':return 'end';
    default:return null;
  }
}
function Icon({name}:{name:'sound'|'mute'|'help'|'expand'|'pause'}){return <svg viewBox="0 0 24 24" aria-hidden="true">{name==='sound'||name==='mute'?<><path d="M11 4 6 8H3v8h3l5 4Z"/>{name==='sound'?<><path d="M15 8c3 2 3 6 0 8M18 5c5 4 5 10 0 14"/></>:<path d="m16 9 6 6m0-6-6 6"/>}</>:name==='help'?<><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5c0-3 6-3 5 0-.5 2-2.5 1.5-2.5 4M12 16v.2"/></>:name==='expand'?<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>:<path d="M8 5v14M16 5v14"/>}</svg>}
function Modal({kind,onClose,onRestart,reduced,onReduced,pauseVerse}:{kind:'help'|'pause';onClose:()=>void;onRestart:()=>void;reduced:boolean;onReduced:(v:boolean)=>void;pauseVerse:VerseData}){const ref=useDialogFocusTrap(onClose);return <div className="modal-scrim" onMouseDown={onClose}><div className={kind==='help'?'help-modal':'pause-modal'} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onMouseDown={e=>e.stopPropagation()}><button className="modal-close" aria-label="Close" onClick={onClose}>×</button><p className="eyebrow">{kind==='help'?'WHITEPAPER · PEER-REVIEWED BY MUNCH':'PROPOSAL #004 · STILL NOT ENFORCED'}</p><h2 id="dialog-title">{kind==='help'?'A very questionable protocol.':'Take a breather.'}</h2>{kind==='help'?<><Verse v={VERSES.help} className="epigraph"/><p>The devs cooked, and this is what they cooked. It eats tokens. Yours. It has a full Bitcoin node where its stomach should be, so Bitcoin and Ether go down in the same bite. Keep it fed for as long as you can; it grows with every coin, and it always wins.</p><div className="help-steps"><div className="help-step"><span>1</span><div><strong>Feed it your tokens. Constantly.</strong><p>Pick a coin with 1, 2 or 3. Aim with the mouse or ← →. Hold Space to charge, let go to launch. Every coin flies its own way: Bitcoin is heavy: lob it high at full charge. Ether floats in on the middle arc, whatever the charge. HEMI flies dead straight: point it at the mouth. Its mouth is open unless it is chewing. A coin thrown into a chewing mouth reverts. When it wants one coin, a ring round it says which and how long: that coin curves in on its own, anything else barely fills it (NOT THAT.), and a craving it waits out ends in a tantrum. Tuned for the hand-eye coordination of a sloth <cite>({VERSES.sloth.who} {VERSES.sloth.at})</cite>.</p></div></div><div className="help-step"><span>2</span><div><strong>The kitchen is a playground.</strong><p>Bank a coin off the pan, the shelf, the chain, the pot or the lamp on the way in and the serving multiplies. Two banks is a multi-hop. Five catches in a row is FOMO: everything counts triple. A block swings on a chain under the ceiling, marked with one coin: hit it with that coin and everything inside goes in the mouth. It will not say thank you.</p></div></div><div className="help-step"><span>3</span><div><strong>Enough of one coin changes it for good.</strong><p>Bitcoin gives it HODL jaws: it pulls in everything metal, forks and hardware wallets included, and never lets go. Ether gives it a gas belly: it floats, and the belly bounces. HEMI gives it turbo breath that cooks coins for double. It locks up every HEMI it eats, so technically that breath is veHEMI. When it runs out of gas, your shift is over. There is no refund.</p></div></div><div className="help-step"><span>4</span><div><strong>{INHERITED.help.title}</strong><p>{INHERITED.help.body}</p></div></div></div><label className="reduced-label"><input type="checkbox" checked={reduced} onChange={e=>onReduced(e.target.checked)}/> Reduce motion and particles</label><button className="primary-control" onClick={onClose}>Got it <span className="arrow">→</span></button></>:<><p>Paused.</p><Verse v={pauseVerse}/><button className="primary-control" onClick={onClose}>Back to the kitchen <span className="arrow">→</span></button><button className="text-button" onClick={onRestart}>Restart shift</button></>}</div></div>}
function clone(run:ArcadeState){return {...run,servings:{...run.servings},mutations:{...run.mutations},creature:copyCreature(run.creature),threat:run.threat?{...run.threat}:null,craving:run.craving?{...run.craving}:null,vent:run.vent?{...run.vent}:null,flame:run.flame?{...run.flame}:null,events:[...run.events],projectiles:[...run.projectiles]};}
export default function Home(){
  const [view,setView]=useState<ArcadeState|null>(null);const [selected,setSelected]=useState<Ingredient>('pepper');const [angle,setAngle]=useState<number>(ARENA.defaultAngle);const [active,setActive]=useState(false);const [dialog,setDialog]=useState<'audio'|'help'|'pause'|null>(null);const [audio,setAudio]=useState<AudioSettings>(DEFAULT_AUDIO_SETTINGS);const [reduced,setReduced]=useState(false);const [best,setBest]=useState(0);const [bestSeconds,setBestSeconds]=useState(0);const [shiftNo,setShiftNo]=useState(1);const [newBest,setNewBest]=useState(false);const [armed,setArmed]=useState(true);const [season,setSeason]=useState<Season>(null);const [titleVerse,setTitleVerse]=useState<VerseData|null>(null);const [pressedE,setPressedE]=useState<{n:number;text:string}|null>(null);const [eHit,setEHit]=useState<{n:number;index:number}|null>(null);
  const runRef=useRef<ArcadeState|null>(null);const engineRef=useRef<MixerAudioEngine|null>(null);const commands=useRef<ArcadeCommand[]>([]);const seenEvent=useRef(0);const shell=useRef<HTMLDivElement>(null);const bestRef=useRef(0);const bestTicks=useRef(0);const angleRef=useRef<number>(ARENA.defaultAngle);const held=useRef(new Set<string>());const manual=useRef(false);const charging=useRef<number|null>(null);const shifts=useRef(0);const hitStop=useRef(0);const reducedRef=useRef(false);const pressesE=useRef(0);const pressETimer=useRef<number|null>(null);const eHitIndex=useRef(-1);const signSeen=useRef(-1);const endedAt=useRef(0);const armTimer=useRef<number|null>(null);
  useEffect(()=>{reducedRef.current=reduced;},[reduced]);
  // The chain (docs/CHAIN.md §8): config and world on mount, a ticket per shift when it is enabled. `ticket` is null for a practice shift.
  const chain=useChain();const {ticket:nextTicket}=chain;const [ticket,setTicket]=useState<Ticket|null>(null);const starting=useRef(false);
  // The season is read after mount, in the viewer's own time zone, so the server render and the first client render agree.
  // The title's verse: the car's on the first visit of the day, then one per visit (the shift count), read after mount for the same reason.
  useEffect(()=>{const handle=requestAnimationFrame(()=>{setSeason(seasonFor(new Date(),location.search));let visits=0,fresh=true;try{visits=Number(localStorage.getItem('dnfi-shifts')||0);const today=new Date().toDateString();fresh=localStorage.getItem('dnfi-last-visit')!==today;localStorage.setItem('dnfi-last-visit',today);}catch{}
    // The flying car's verse opens the first visit of the day (a judge's machine may have loaded the game before the stream); later visits turn the verses over.
    setTitleVerse(fresh?VERSES.car:verseAt(VERSES.title,visits));});return()=>cancelAnimationFrame(handle);},[]);
  // Press E. It does nothing to the shift and is never recorded; it only says so.
  // While the creature's PRESS E sign is up (one hit per sign) E is a hit: the scene throws IT WORKED. and a burst, and here it goes ding ding ding.
  const pressE=useCallback(()=>{const run=runRef.current;const sign=active&&run&&run.phase==='playing'?pressEPhase(run.tick):null;if(sign&&sign.index!==eHitIndex.current){eHitIndex.current=sign.index;setEHit(h=>({n:(h?.n??0)+1,index:sign.index}));const engine=engineRef.current;engine?.unlock();(['clink-btc','clink-eth','clink-hemi'] as SfxId[]).forEach((cue,i)=>window.setTimeout(()=>engine?.play(cue),i*120));return;}pressesE.current+=1;const n=pressesE.current;setPressedE({n,text:pressELine(n)});engineRef.current?.unlock();engineRef.current?.play('ui-click');if(pressETimer.current!==null)clearTimeout(pressETimer.current);pressETimer.current=window.setTimeout(()=>{setPressedE(null);pressETimer.current=null;},1700);},[active]);
  useEffect(()=>()=>{if(pressETimer.current!==null)clearTimeout(pressETimer.current);},[]);
  useEffect(()=>{const engine=createAudioEngine();engineRef.current=engine;const saved=readAudioSettings();applyAudioPatch(engine,saved);const handle=requestAnimationFrame(()=>{setAudio(saved);try{const n=Number(localStorage.getItem('dnfi-arcade-best-v2'));if(Number.isFinite(n)&&n>0){setBest(n);bestRef.current=n;}const t=Number(localStorage.getItem('dnfi-arcade-best-ticks-v2'));if(Number.isFinite(t)&&t>0){bestTicks.current=t;setBestSeconds(Math.floor(t/60));}const motion=localStorage.getItem('dnfi-reduced-motion');setReduced(motion===null?matchMedia('(prefers-reduced-motion: reduce)').matches:motion==='true');}catch{}});return()=>{cancelAnimationFrame(handle);engine.dispose();engineRef.current=null;};},[]);
  const changeAudio=useCallback((patch:Partial<AudioSettings>)=>{engineRef.current?.unlock();if(engineRef.current)applyAudioPatch(engineRef.current,patch);setAudio(prev=>{const next={...prev,...patch};writeAudioSettings(next);return next;});},[]);
  const changeReduced=(v:boolean)=>{setReduced(v);try{localStorage.setItem('dnfi-reduced-motion',String(v));}catch{}};
  const aim=useCallback((v:number)=>{const next=Math.round(Math.max(ARENA.minAngle,Math.min(ARENA.maxAngle,v)));angleRef.current=next;setAngle(next);},[]);
  const start=useCallback(()=>{if(starting.current)return;starting.current=true;engineRef.current?.unlock();void nextTicket().then(issued=>{starting.current=false;setTicket(issued);runRef.current=createArcade(issued?issued.seed:crypto.getRandomValues(new Uint32Array(1))[0],issued?inheritedOf(issued.inherited):null);commands.current=[];seenEvent.current=0;held.current.clear();charging.current=null;hitStop.current=0;try{shifts.current=Number(localStorage.getItem('dnfi-shifts')||0)+1;localStorage.setItem('dnfi-shifts',String(shifts.current));}catch{shifts.current+=1;}setShiftNo(shifts.current);eHitIndex.current=-1;signSeen.current=-1;setSelected('pepper');aim(ARENA.defaultAngle);setView(clone(runRef.current));setNewBest(false);setDialog(null);setActive(true);engineRef.current?.unlock();engineRef.current?.play('ui-click');requestAnimationFrame(()=>document.querySelector<HTMLCanvasElement>('.game-canvas')?.focus({preventScroll:true}));});},[aim,nextTicket]);
  const serve=useCallback((power:number)=>{const run=runRef.current;if(!active||dialog||!run)return;engineRef.current?.unlock();const p=Math.round(Math.max(ARENA.minPower,Math.min(ARENA.maxPower,power)));if(applyGameCommand(run,commands.current,{tick:run.tick,kind:'launch',ingredient:selected,angle:angleRef.current,power:p}))setView(clone(run));},[active,dialog,selected]);
  const hatch=useCallback(()=>{const run=runRef.current;if(!active||dialog||!run)return;engineRef.current?.unlock();if(applyGameCommand(run,commands.current,{tick:run.tick,kind:'hatch'})){engineRef.current?.play('ui-click');setView(clone(run));}},[active,dialog]);
  const cancelCharge=useCallback(()=>{charging.current=null;if(runRef.current)runRef.current.charge=0;},[]);
  const beginCharge=useCallback(()=>{if(!active||dialog||!runRef.current)return;engineRef.current?.unlock();if(charging.current===null)charging.current=runRef.current.tick;},[active,dialog]);
  const releaseCharge=useCallback(()=>{const from=charging.current;cancelCharge();if(from===null)return;const heldTicks=runRef.current?Math.max(0,runRef.current.tick-from):0;serve(ARENA.minPower+(ARENA.maxPower-ARENA.minPower)*Math.min(1,heldTicks/ARENA.chargeTicks));},[cancelCharge,serve]);
  useEffect(()=>{if(dialog||!active){held.current.clear();cancelCharge();}},[active,dialog,cancelCharge]);
  useEffect(()=>{if(!active)return;let frame=0,last=performance.now(),remainder=0,lastHud=0;const update=(now:number)=>{const run=runRef.current;if(!run)return;if(!dialog&&!document.hidden){
        // The hit-stop: for three frames after a catch the simulation holds.
        // Time is not banked — the remainder is dropped — so the world resumes
        // at its own pace rather than lurching to catch up. Under reduced
        // motion there is no hold.
        const holding=hitStop.current>0&&!reducedRef.current;
        if(holding){hitStop.current-=1;remainder=0;}
        else remainder+=Math.min(.1,(now-last)/1000)*60;
        const steps=(DEV_HOOKS&&manual.current)||holding?0:Math.floor(remainder);remainder-=steps;const dir=(held.current.has('ArrowRight')||held.current.has('d')?1:0)-(held.current.has('ArrowLeft')||held.current.has('a')?1:0);if(dir&&steps){const aimSteps=Math.floor((run.tick+steps)/2)-Math.floor(run.tick/2);if(aimSteps)aim(angleRef.current+dir*aimSteps);}for(let i=0;i<steps;i++)stepArcade(run);if(charging.current!==null)run.charge=Math.min(1,Math.max(0,(run.tick-charging.current)/ARENA.chargeTicks));else run.charge=0;
        for(const event of run.events){if(event.id<=seenEvent.current)continue;seenEvent.current=event.id;const cue=cueFor(event);if(cue)engineRef.current?.play(cue);const clink=clinkFor(event);if(clink)engineRef.current?.play(clink);if(event.type==='feed'||(event.type==='utensil'&&event.name==='caught'))hitStop.current=HIT_STOP_FRAMES;}
        // The creature spits a PRESS E sign: a whoosh as it leaves the mouth.
        const sign=run.phase==='playing'?pressEPhase(run.tick):null;if(sign&&sign.index!==signSeen.current){signSeen.current=sign.index;engineRef.current?.play('launch');}
        engineRef.current?.setFrenzy(inFrenzy(run));
        // The score worries with the shift: an emptying belly or rising irritation.
        engineRef.current?.setTension(tensionFor(run.hunger,run.rage));
        if(now-lastHud>80||run.phase!=='playing'){setView(clone(run));lastHud=now;}}last=now;if(run.phase!=='playing'){endedAt.current=performance.now();setArmed(false);if(armTimer.current!==null)window.clearTimeout(armTimer.current);armTimer.current=window.setTimeout(()=>{armTimer.current=null;setArmed(true);},RESTART_LOCK_MS);setActive(false);engineRef.current?.setFrenzy(false);if(run.score>bestRef.current){bestRef.current=run.score;setBest(run.score);try{localStorage.setItem('dnfi-arcade-best-v2',String(run.score));}catch{}}if(run.tick>bestTicks.current){const hadOne=bestTicks.current>0;bestTicks.current=run.tick;setBestSeconds(Math.floor(run.tick/60));setNewBest(hadOne);try{localStorage.setItem('dnfi-arcade-best-ticks-v2',String(run.tick));}catch{}}return;}frame=requestAnimationFrame(update);};frame=requestAnimationFrame(update);return()=>cancelAnimationFrame(frame);},[active,dialog,aim]);
  useEffect(()=>{engineRef.current?.setPlaying(active&&!dialog);},[active,dialog]);
  useEffect(()=>()=>{if(armTimer.current!==null)window.clearTimeout(armTimer.current);},[]);
  useEffect(()=>{const stop=()=>{held.current.clear();cancelCharge();if(active)setDialog(current=>current??'pause');};const visibility=()=>{if(document.hidden)stop();};window.addEventListener('blur',stop);document.addEventListener('visibilitychange',visibility);return()=>{window.removeEventListener('blur',stop);document.removeEventListener('visibilitychange',visibility);};},[active,cancelCharge]);
  useEffect(()=>{const down=(e:KeyboardEvent)=>{if(dialog||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==='Escape'&&active){e.preventDefault();held.current.clear();setDialog('pause');return;}if((e.key==='e'||e.key==='E')&&!e.repeat){e.preventDefault();pressE();return;}const target=e.target instanceof HTMLElement?e.target:null;if(target?.closest('input,textarea,select,button,[contenteditable=true]'))return;const key=e.key.length===1?e.key.toLowerCase():e.key;if(['ArrowLeft','ArrowRight','a','d'].includes(key)&&active){e.preventDefault();held.current.add(key);if(!e.repeat)aim(angleRef.current+(['ArrowRight','d'].includes(key)?1:-1));}if(e.repeat)return;if(['1','2','3'].includes(key)){e.preventDefault();setSelected(FOODS[Number(key)-1]);}const locked=()=>performance.now()-endedAt.current<RESTART_LOCK_MS;if(e.code==='Space'){e.preventDefault();if(active){if(charging.current===null)charging.current=runRef.current?.tick??0;}else if(!locked())start();}
    if((key==='s'||key==='ArrowDown')&&active){e.preventDefault();hatch();}if(key==='r'&&!active&&!locked()){e.preventDefault();start();}};const up=(e:KeyboardEvent)=>{held.current.delete(e.key.length===1?e.key.toLowerCase():e.key);
      if(e.code==='Space')releaseCharge();};window.addEventListener('keydown',down);window.addEventListener('keyup',up);return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);};},[active,dialog,releaseCharge,hatch,start,aim,pressE]);
  useEffect(()=>{if(!DEV_HOOKS)return;const bag=devHookBag();if(!bag)return;
    const snapshot=()=>{const run=runRef.current;return run?{tick:run.tick,phase:run.phase,failureReason:run.failureReason,hunger:run.hunger,rage:run.rage,score:run.score,combo:run.combo,bestCombo:run.bestCombo,frenzies:run.frenzies,frenzyUntil:run.frenzyUntil,banks:run.banks,clanks:run.clanks,cooked:run.cooked,utensils:run.utensils,wanted:run.wanted,servings:{...run.servings},mutations:{...run.mutations},threat:run.threat?{...run.threat}:null,craving:run.craving?{...run.craving}:null,flame:run.flame?{...run.flame}:null,benchFireUntil:run.benchFireUntil,creature:{...run.creature},size:run.size,appetite:run.appetite,misses:run.misses,totalFeeds:run.totalFeeds,hatchClosedUntil:run.hatchClosedUntil,hatchReadyAt:run.hatchReadyAt,reloadUntil:run.reloadUntil,vent:run.vent?{...run.vent}:null,ending:run.ending,crates:run.crates.map(c=>({...c})),cratesBroken:run.cratesBroken,cratesLost:run.cratesLost,projectiles:run.projectiles.length,events:run.events.slice(-8).map(e=>({tick:e.tick,type:e.type,label:e.label,name:e.name??null,ingredient:e.ingredient??null}))}:null;};
    bag.play={
      start:(seed=1234,inherited:Ingredient|null=null)=>{eHitIndex.current=-1;signSeen.current=-1;setTicket(null);runRef.current=createArcade(seed>>>0,inherited);commands.current=[];seenEvent.current=0;held.current.clear();hitStop.current=0;manual.current=true;setSelected('metal');aim(ARENA.defaultAngle);setView(clone(runRef.current));setNewBest(false);setDialog(null);setActive(true);return snapshot();},
      manual:(value:boolean)=>{manual.current=value;},
      step:(count=1)=>{const run=runRef.current;if(!run)return null;for(let i=0;i<count&&run.phase==='playing';i++)stepArcade(run);setView(clone(run));return snapshot();},
      launch:(ingredient:Ingredient,angleValue:number,power?:number)=>{const run=runRef.current;if(!run)return false;setSelected(ingredient);aim(angleValue);const p=Math.round(power??ARENA.defaultPower);const fired=applyGameCommand(run,commands.current,{tick:run.tick,kind:'launch',ingredient,angle:Math.round(angleValue),power:p});setView(clone(run));return fired;},
      hatch:()=>{const run=runRef.current;if(!run)return false;const ok=applyGameCommand(run,commands.current,{tick:run.tick,kind:'hatch'});setView(clone(run));return ok;},
      select:(ingredient:Ingredient)=>{setSelected(ingredient);},
      // Development only: sets the belly and irritation directly, so a HUD
      // state that takes a hundred seconds of play to reach can be
      // photographed in one frame. It writes state, never rules.
      vitals:(v:{hunger?:number;rage?:number;combo?:number})=>{const run=runRef.current;if(!run)return null;if(v.hunger!==undefined)run.hunger=v.hunger;if(v.rage!==undefined)run.rage=v.rage;if(v.combo!==undefined)run.combo=v.combo;setView(clone(run));return snapshot();},
      // Development only: jumps the creature to a given size so the render
      // budget can be measured at the size it actually costs the most.
      setSize:(value:number)=>{const run=runRef.current;if(!run)return null;run.creature.size=value;run.size=value;setView(clone(run));return snapshot();},
      // Development only: puts the creature straight into a given set of
      // mutation levels so a capture can check what each one looks like.
      // `lift` is honoured; the legacy `clog` and `pressure` are accepted and
      // ignored, since the rules no longer have them.
      setMutations:(levels:{metal?:number;balloon?:number;pepper?:number},extra?:{clog?:number;lift?:number;pressure?:number;track?:number})=>{
        const run=runRef.current;if(!run)return null;
        run.mutations.metal=levels.metal??0;run.mutations.balloon=levels.balloon??0;run.mutations.pepper=levels.pepper??0;
        for(const food of FOODS)run.servings[food]=servingsForLevel(run.mutations[food]);
        if(extra?.lift!==undefined)run.creature.lift=extra.lift;
        if(extra?.track!==undefined)run.creature.track=extra.track;
        setView(clone(run));return snapshot();},
      point:(value:number)=>{aim(value);},
      // Development only: irritation is otherwise only reachable by missing.
      // Development only: no beats, blocks, cravings, cutlery or flames, so a
      // capture shows one thing happening.
      quiet:()=>{const run=runRef.current;if(!run)return;run.beatAt=run.crateAt=run.cravingNextAt=run.junkAt=run.flameAt=1e9;},
      setRage:(value:number)=>{const run=runRef.current;if(!run)return;run.rage=Math.max(0,Math.min(100,value));setView(clone(run));},
      // Development only: holds or releases the charge the way the space bar
      // does, so a capture can show the launcher winding up before a shot.
      hold:(on:boolean,fromTick?:number)=>{const run=runRef.current;charging.current=on?(fromTick??run?.tick??0):null;if(!on&&run)run.charge=0;},
      state:snapshot,
      commands:()=>commands.current.map(item=>({...item})),
      stop:()=>{manual.current=false;setActive(false);},
    };
    return()=>{delete bag.play;};
  },[aim]);
  // The shift is endless, so the clock counts up.
  const seconds=view?Math.floor(view.tick/60):0;
  const traits=view?FOODS.filter(f=>view.mutations[f]>0):[];const ready=active&&!!view&&view.tick-view.lastLaunchTick>=(inFrenzy(view)?ARENA.frenzyCooldownTicks:ARENA.cooldownTicks)&&view.tick>=view.reloadUntil&&view.tick>=view.hatchClosedUntil;const ended=view&&!active;const clock=(total:number)=>`${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
  // The trajectory guide is a first-shift aid and then it is gone.
  const guideSteps=!active||!view?0:shiftNo<=1?(view.tick<900?34:10):shiftNo<=2?8:0;
  // The community diet, from the world's pile when the chain layer has one; the stub (null) says nothing.
  const dietLine=communityDietLine(chain.diet??communityDiet);
  // The report's headline: the night lost, or a new personal best. Surviving to the cap is never a loss.
  const headline=newBest||view?.failureReason==='outgrew-the-kitchen'?HEADLINES.back:HEADLINES.over;
  const fullscreen=()=>{if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});else void shell.current?.requestFullscreen?.().catch(()=>{});};
  return <main><header className="masthead"><div className="brand"><div className="brand-mark" aria-hidden="true">!</div><div><h1>DO NOT FEED IT</h1><p>QUESTIONABLE APPETITES DAO</p></div></div><div className="header-actions"><span className="practice-label"><i className="status-dot"/> {headerLabel(ticket,chain.info,shiftNo,chain.config,!!view)}</span><button className="icon-button" onClick={()=>changeAudio({muted:!audio.muted})} aria-label={audio.muted?'Unmute sound':'Mute sound'} title={audio.muted?'Unmute':'Mute'}><Icon name={audio.muted?'mute':'sound'}/></button><input className="volume-control" type="range" min="0" max="100" value={Math.round(audio.master*100)} onChange={e=>changeAudio({master:Number(e.target.value)/100})} aria-label="Master volume"/><button className="icon-button" onClick={()=>setDialog('help')} aria-label="How to play" title="How to play"><Icon name="help"/></button><button className="icon-button" onClick={fullscreen} aria-label="Toggle fullscreen" title="Fullscreen"><Icon name="expand"/></button>{active&&<button className="icon-button" onClick={()=>setDialog('pause')} aria-label="Pause game" title="Pause"><Icon name="pause"/></button>}</div></header>
    <div className="game-shell" ref={shell}><section className={`stage ${ended?'is-result':''} ${season==='halloween'?'halloween':''}`} aria-label="Creature feeding kitchen"><GameCanvas runRef={runRef} angle={angle} selected={selected} playing={active} reduced={reduced} guideSteps={guideSteps} season={season} pressE={eHit} onAim={aim}/><div className="stage-vignette"/>
    <div className="hud"><div className="score-group"><div><div className="hud-label">{active?'SCORE':'BEST SHIFT'}</div><div className="hud-value score">{active?String(view?.score??0).padStart(5,'0'):best>0?String(best).padStart(5,'0'):"-----"}</div></div></div><div className={`hud-timer ${active&&(view?.hunger??100)<25?'low':''}`}><span className="hud-label">{active?'UPTIME':ended?'FINAL UPTIME':'BEST UPTIME'}</span><div className="hud-value">{active||ended?clock(seconds):bestSeconds>0?clock(bestSeconds):"--:--"}</div></div></div>
    {!active&&!ended&&<div className="start-copy"><div className="section-tag">{season==='halloween'?HALLOWEEN.tag:'PROPOSAL #004 · PASSED'}</div><h2>DO NOT<br/>FEED <span>IT.</span></h2><p className="lede">{season==='halloween'?HALLOWEEN.ledeFirst:'It passed. Nobody enforces it.'}<br/>Feed it your tokens. Deal with what it becomes.</p><button className="primary-control" onClick={start}>Start your shift <span className="arrow">→</span></button><p className="start-note">Free to play · No wallet needed · Not financial advice · Press E</p>{titleVerse&&<Verse v={titleVerse} className="title-verse"/>}</div>}
    {ended&&<div className="start-copy result-copy"><div className="section-tag">EPOCH REPORT</div><h2>{headline[0]}<br/><span>{headline[1]}</span></h2><div className="result-cause">{CAUSES[view.failureReason??'empty-belly']}</div><div className="result-joke">{ENDING_JOKES[view.ending]??ENDING_JOKES[0]}</div><p className="lede">{(WALLET_TIERS[view.ending]??WALLET_TIERS[0]).line}</p><div className="result-score">{clock(Math.floor(view.tick/60))} <span className="hud-label">UPTIME</span></div><div className="result-sub">{view.score.toLocaleString()} pts</div>{newBest&&<div className="record">✦ New personal best. Ding, ding, ding. <cite>{VERSES.newBest.who} {VERSES.newBest.at}</cite></div>}<div className="result-stats"><div><small>TOKENS FED</small><strong>{view.totalFeeds}</strong></div><div><small>BEST COMBO</small><strong>×{view.bestCombo}</strong></div><div><small>FOMO</small><strong>{view.frenzies}</strong></div><div><small>FINAL SIZE</small><strong>×{view.creature.size.toFixed(2)}</strong></div></div><Ledger ticket={ticket} commands={commands} endTick={view.tick} played={view} chain={chain}/><div className={`result-actions ${armed?'is-armed':''}`}><button className="primary-control" onClick={()=>{if(armed)start();}} aria-disabled={!armed} tabIndex={armed?0:-1}>Ape back in <span className="arrow">↗</span></button><Verse v={VERSES.restart} className="restart-verse"/></div></div>}
    {active&&view&&traits.length>0&&<div className="trait-stack">{traits.map(f=><div key={`${f}-${view.mutations[f]}`} className={`trait-chip ${f} ${reduced?'':'landed'}`}><TokenMark food={f}/><span><strong>{TRAITS[f]}</strong>{view.mutations[f]===1&&view.inherited===f&&<i className="trait-inherited">{INHERITED.tag}</i>}</span><em>×{view.mutations[f]}</em></div>)}</div>}
    {!active&&<div className="scene-caption"><div className="subject-name">SPECIMEN 04 · “MUNCH”</div><p>Friendly disposition. Full Bitcoin node for a stomach.</p>{season==='halloween'&&<p className="costume">{HALLOWEEN.costume}</p>}</div>}
    {pressedE&&<div key={pressedE.n} className={`press-e ${active?'in-play':'idle'} ${reduced?'still':''}`} role="status">{pressedE.text}</div>}</section>
    {active?<div className="control-deck"><fieldset className="ingredients"><legend className="sr-only">Load a coin</legend>{FOODS.map((food,index)=><button className="ingredient" key={food} aria-pressed={selected===food} onClick={event=>{setSelected(food);engineRef.current?.play('ui-click');if(event.detail>0&&active)document.querySelector<HTMLCanvasElement>('.game-canvas')?.focus({preventScroll:true});}}><TokenMark food={food}/><span><span className="ingredient-name">{LABELS[food]}</span><span className="ingredient-desc">{TOKEN_FLIGHT[food]} · {TRAITS[food]}</span></span><kbd>{index+1}</kbd></button>)}</fieldset><div className="launch-area"><label className="aim-touch">Aim <input aria-label="Aim angle" type="range" min={ARENA.minAngle} max={ARENA.maxAngle} value={angle} onChange={e=>aim(Number(e.target.value))}/></label><button className="primary-control launch-button" style={{'--reload':`${view?Math.min(100,view.tick<view.reloadUntil?0:(view.tick-view.lastLaunchTick)/(inFrenzy(view)?ARENA.frenzyCooldownTicks:ARENA.cooldownTicks)*100):100}%`,'--charge':`${Math.round((view?.charge??0)*100)}%`} as React.CSSProperties} onPointerDown={event=>{if(event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);beginCharge();}} onPointerUp={event=>{if(event.button===0)releaseCharge();}} onPointerCancel={cancelCharge} onLostPointerCapture={cancelCharge} onBlur={cancelCharge} onKeyDown={event=>{if(event.code==='Space'){event.preventDefault();if(!event.repeat)beginCharge();}}} onKeyUp={event=>{if(event.code==='Space'){event.preventDefault();releaseCharge();}}} onClick={event=>{if(event.detail===0)serve(ARENA.defaultPower);}} disabled={active&&!ready}>{active?(view&&view.tick<view.reloadUntil?'Jammed':'Launch'):'Clock in'}<kbd>{active?'HOLD SPACE':'↗'}</kbd></button></div></div>:<div className="preflight"><span>AIM. HODL. FEED.</span><div className="preflight-foods"><TokenMark food="metal"/><TokenMark food="balloon"/><TokenMark food="pepper"/><div><p>One mouth. Zero restraint. Maximum commitment.</p>{dietLine&&<p className="diet-line">{dietLine}<DietClose chain={chain}/></p>}<InheritedLine chain={chain}/><LastFiling chain={chain}/><TopKeepers world={chain.world}/></div></div><nav className="preflight-actions" aria-label="Game options"><button className="text-button" onClick={()=>setDialog('help')}>How to play</button><button className="text-button" onClick={()=>setDialog('audio')}>Sound mix</button></nav></div>}</div>
    <footer className="underbar"><div className={`keyboard-guide ${active?'':'inactive'}`}><span><kbd>1</kbd> Bitcoin · heavy</span><span><kbd>2</kbd> Ether · floats</span><span><kbd>3</kbd> HEMI · straight</span><span><kbd>SPACE</kbd> Hold to charge, release to launch</span></div><div className="underbar-right"><span>{chain.config?.enabled?`${chain.info.label} · Filing is optional · Best saved on this device`:chain.config?'Local practice · Scores saved on this device':'Free to play · Best saved on this device'}</span>{active&&<button className="text-button" onClick={()=>setDialog('audio')}>Sound mix</button>}</div></footer>
    {dialog==='audio'&&<AudioPanel settings={audio} onChange={changeAudio} onClose={()=>setDialog(null)}/>} {(dialog==='help'||dialog==='pause')&&<Modal kind={dialog} onClose={()=>setDialog(null)} onRestart={start} reduced={reduced} onReduced={changeReduced} pauseVerse={verseAt(VERSES.pause,Math.floor((view?.tick??0)/60))}/>}
  </main>;
}
