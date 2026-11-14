import { refreshTaxonomy } from "../taxonomy";
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api, Garment } from '../api';
import { inputCls, PickChips, toast } from './ui';

type Catalog = { brands: string[]; usage: Record<string, Record<string, number>> };
let cached: Promise<Catalog> | undefined;
let subscribers = 0;
function catalog() {
  if (!cached) cached = (async () => {
    const brands = new Set<string>();
    const usage: Catalog['usage'] = {};
    let offset: number | null = 0;
    do {
      const r: { garments: Garment[]; next_offset: number | null } = await api(`/api/garments?limit=200&offset=${offset}`);
      for (const g of r.garments) {
        if (g.brand) brands.add(g.brand);
        for (const id of ['pattern_tags', 'decoration']) {
          const raw = g.attributes?.[id];
          const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
          usage[id] ||= {};
          for (const v of new Set(values.map(String))) usage[id][v] = (usage[id][v] || 0) + 1;
        }
      }
      offset = r.next_offset;
    } while (offset !== null);
    return { brands: [...brands].sort((a,b)=>a.localeCompare(b)), usage };
  })().catch(e => { cached = undefined; throw e; });
  return cached;
}
function useCatalog() {
  const [value, setValue] = useState<Catalog>({ brands: [], usage: {} });
  useEffect(() => { let alive=true; subscribers++; catalog().then(v=>{if(alive)setValue(v)}).catch(()=>{}); return ()=>{alive=false; subscribers--; if(!subscribers)cached=undefined;}; }, []);
  return value;
}
export function BrandInput({ value, onChange, disabled }: { value:string; onChange:(v:string)=>void; disabled?:boolean }) {
  const { brands } = useCatalog();
  const [open,setOpen] = useState(false);
  const [filter,setFilter] = useState(false);
  const [active,setActive] = useState(-1);
  const listId = useId();
  const choices = brands.filter(b=>!filter||b.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  const pick = (brand:string) => {onChange(brand);setOpen(false);setFilter(false);setActive(-1)};
  return <div className="relative" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false)}}>
    <input role="combobox" aria-label="品牌，可輸入或選擇" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open&&active>=0?`${listId}-${active}`:undefined} autoComplete="off" className={`${inputCls} pr-10`} value={value} disabled={disabled} placeholder="輸入／選擇品牌" onFocus={()=>{setOpen(true);setFilter(false)}} onChange={e=>{onChange(e.target.value);setOpen(true);setFilter(true);setActive(-1)}} onKeyDown={e=>{
      if(e.key==='Escape'){setOpen(false);e.preventDefault()}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);setActive(i=>choices.length?(e.key==='ArrowDown'?Math.min(i+1,choices.length-1):Math.max(i-1,0)):-1)}
      if(e.key==='Enter'&&open&&active>=0&&choices[active]){e.preventDefault();pick(choices[active])}
    }}/>
    <button type="button" disabled={disabled} aria-label="展開品牌選單" aria-expanded={open} className="absolute right-0 top-0 h-full w-10 text-ink" onClick={()=>{setOpen(v=>!v);setFilter(false);setActive(-1)}}>⌄</button>
    {open&&<div id={listId} role="listbox" aria-label="品牌選項" className="absolute inset-x-0 top-full z-40 mt-1 max-h-60 overflow-y-auto rounded-2xl border border-gold bg-field p-1 text-ink shadow-xl">
      {choices.map((b,i)=><button type="button" role="option" id={`${listId}-${i}`} aria-selected={value===b} key={b} className={`block w-full px-3 py-3 text-left text-sm ${active===i?'bg-rose':''}`} onMouseDown={e=>e.preventDefault()} onClick={()=>pick(b)}>{b}</button>)}
      {!choices.length&&<p className="p-3 text-sm">可直接使用輸入的品牌</p>}
    </div>}
  </div>;
}

export const COLORS: Record<string,string> = {黑:'#19141b',白:'#fffaf2',灰:'#99949f',粉紅:'#eaa5c7',紅:'#bf425c',紫:'#9362a6',藍:'#6383b5',綠:'#668878',黃:'#e8ca7c',橙:'#da925e',啡:'#967158',米色:'#e8d9b7',金:'linear-gradient(135deg,#997124,#f3d789,#be9646)',銀:'linear-gradient(135deg,#8e94a4,#e3e6ee,#acb1be)',多色:'conic-gradient(#9566bb 0 25%,#e8c479 0 50%,#82b5b3 0 75%,#e9a2c3 0)'};
export function AttributeChoices(props: { id:string; options:string[]; value:string[]; onChange:(v:string[])=>void; multi?:boolean; max?:number|null; extra?:boolean }) {
  const { id, options, value, onChange, multi, max } = props;
  const { usage } = useCatalog();
  const [expanded, setExpanded] = useState(false);
  const region = useId();
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount,setVisibleCount] = useState(8);
  const [custom,setCustom] = useState<Record<string,string>>({});
  const [adding,setAdding] = useState(false);
  const [name,setName] = useState('');
  const [hex,setHex] = useState('#9875a9');
  const [saving,setSaving] = useState(false);
  const color = id === 'primary_color' || id === 'secondary_colors';
  const collapse = id === 'pattern_tags' || id === 'decoration';
  useEffect(()=>{
    if(!color)return;
    let alive=true;
    const load=()=>api<Record<string,string>>('/api/settings/colors').then(v=>{if(alive)setCustom(v)}).catch(()=>{});
    void load(); window.addEventListener('aw:colors',load);
    return ()=>{alive=false;window.removeEventListener('aw:colors',load)};
  },[color]);
  const all = [...new Set([...options, ...(color?Object.keys(custom):[]), ...value])];
  const ranked = collapse ? [...all].sort((a,b)=>(usage[id]?.[b]||0)-(usage[id]?.[a]||0)) : all;
  const shown = collapse && !expanded ? ranked.slice(0,visibleCount) : ranked;
  const hiddenSelected = value.filter(v=>!shown.includes(v));
  const toggle = (o:string) => onChange(value.includes(o)?value.filter(v=>v!==o):multi?[...value,o]:[o]);
  useLayoutEffect(()=>{
    const el=measureRef.current;if(!el)return;
    const measure=()=>{
      const children=Array.from(el.children) as HTMLElement[];
      const rows=[...new Set(children.map(c=>c.offsetTop))].sort((a,b)=>a-b);
      setVisibleCount(children.filter(c=>c.offsetTop<=(rows[1]??rows[0]??0)).length);
    };
    measure(); const observer=new ResizeObserver(measure);observer.observe(el);return ()=>observer.disconnect();
  },[ranked.join('|'),collapse]);
  async function addColor(){
    if(!name.trim())return;
    setSaving(true);
    try{
      const result=await api<Record<string,string>>('/api/settings/colors',{method:'POST',json:{name:name.trim(),hex}});
      setCustom(result);refreshTaxonomy();window.dispatchEvent(new Event('aw:colors'));setAdding(false);setName('');
      if(!multi||!max||value.length<max)onChange(multi?[...value,name.trim()]:[name.trim()]);
      toast('已新增顏色');
    }catch(e){toast((e as Error).message,'err')}finally{setSaving(false)}
  }
  if (!color && !collapse) return <PickChips {...props}/>;
  const chipClass='rounded-full px-3 py-1.5 text-[13px] transition-colors disabled:opacity-35';
  return <div className="relative">
    {collapse&&<div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0 flex flex-wrap gap-1.5">{ranked.map(o=><span key={o} className={`${chipClass} chip`}>{o}</span>)}</div>}
    <div id={region} className={color?'grid grid-cols-8 gap-x-2 gap-y-3':'flex flex-wrap gap-1.5'}>
      {shown.map(o=><button type="button" key={o} aria-pressed={value.includes(o)} disabled={!value.includes(o)&&!!multi&&!!max&&value.length>=max} onClick={()=>toggle(o)} className={color?'flex min-w-0 flex-col items-center gap-1 text-[12px] disabled:opacity-35':`${chipClass} ${value.includes(o)?'chip-on':'chip'}`}>
        {color&&<span className={`grid aspect-square w-full max-w-12 place-items-center rounded-full border-2 ${value.includes(o)?'border-gold ring-2 ring-gold':'border-mauve/60'}`} style={{background:custom[o]||COLORS[o]||'#746578'}}><span className="grid h-5 w-5 place-items-center rounded-full bg-head text-white" style={{visibility:value.includes(o)?'visible':'hidden'}}>✓</span></span>}
        <span>{o}</span>
      </button>)}
    </div>
    {color&&<button type="button" className="mt-3 text-[13px] text-gold-soft underline underline-offset-4" onClick={()=>setAdding(v=>!v)}>＋ 新增顏色</button>}
    {adding&&<div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 p-3">
      <input aria-label="新顏色名稱" className={`${inputCls} min-w-0 flex-1`} maxLength={20} placeholder="顏色名稱" value={name} disabled={saving} onChange={e=>setName(e.target.value)}/>
      <input aria-label="選擇實際顏色" type="color" className="h-10 w-10" value={hex} disabled={saving} onChange={e=>setHex(e.target.value)}/>
      <button type="button" className="chip rounded-full px-3 py-2 text-sm" disabled={saving||!name.trim()} onClick={addColor}>{saving?'新增中…':'新增'}</button>
      <button type="button" className="text-sm text-mauve" disabled={saving} onClick={()=>setAdding(false)}>取消</button>
    </div>}
    {!!hiddenSelected.length&&<div className="mt-2 text-xs text-mauve">其他已選：{hiddenSelected.map(o=><button key={o} type="button" className="chip-on m-1 rounded-full px-2 py-1" onClick={()=>toggle(o)} aria-label={`取消選擇${o}`}>{o} ×</button>)}</div>}
    {collapse&&all.length>visibleCount&&<button type="button" className="mt-3 text-[13px] text-gold-soft underline underline-offset-4" aria-expanded={expanded} aria-controls={region} onClick={()=>setExpanded(v=>!v)}>{expanded?'收起其他選項':'顯示更多選項'}</button>}
  </div>;
}
