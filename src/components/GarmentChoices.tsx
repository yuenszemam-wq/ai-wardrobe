import { useEffect, useId, useState } from 'react';
import { api, Garment } from '../api';
import { inputCls, PickChips } from './ui';

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
  return <div className="space-y-2">
    <select aria-label="選擇已有品牌" className={inputCls} disabled={disabled} value={brands.includes(value)?value:''} onChange={e=>{if(e.target.value)onChange(e.target.value)}}>
      <option value="">選擇品牌／自行輸入</option>
      {brands.map(b=><option key={b} value={b}>{b}</option>)}
    </select>
    <input aria-label="品牌名稱，可自由輸入" className={inputCls} value={value} disabled={disabled} placeholder="輸入或修改品牌名稱" onChange={e=>onChange(e.target.value)} />
  </div>;
}
const COLORS: Record<string,string> = {黑:'#19141b',白:'#fffaf2',灰:'#99949f',粉紅:'#eaa5c7',紅:'#bf425c',紫:'#9362a6',藍:'#6383b5',綠:'#668878',黃:'#e8ca7c',橙:'#da925e',啡:'#967158',米色:'#e8d9b7',金:'linear-gradient(135deg,#997124,#f3d789,#be9646)',銀:'linear-gradient(135deg,#8e94a4,#e3e6ee,#acb1be)',多色:'conic-gradient(#9566bb 0 25%,#e8c479 0 50%,#82b5b3 0 75%,#e9a2c3 0)'};
export function AttributeChoices(props: { id:string; options:string[]; value:string[]; onChange:(v:string[])=>void; multi?:boolean; max?:number|null; extra?:boolean }) {
  const { id, options, value, onChange, multi, max } = props;
  const { usage } = useCatalog();
  const [expanded, setExpanded] = useState(false);
  const region = useId();
  const color = id === 'primary_color' || id === 'secondary_colors';
  const collapse = id === 'pattern_tags' || id === 'decoration';
  if (!color && !collapse) return <PickChips {...props}/>;
  const all = [...new Set([...options, ...value])];
  const ranked = collapse ? [...all].sort((a,b)=>(usage[id]?.[b]||0)-(usage[id]?.[a]||0)) : all;
  const shown = collapse && !expanded ? ranked.slice(0,8) : ranked;
  const hiddenSelected = value.filter(v=>!shown.includes(v));
  const toggle = (o:string) => onChange(value.includes(o)?value.filter(v=>v!==o):multi?[...value,o]:[o]);
  return <div>
    <div id={region} className={color?'grid grid-cols-6 gap-x-2 gap-y-3':'grid grid-cols-4 gap-2'}>
      {shown.map(o=><button type="button" key={o} aria-pressed={value.includes(o)} disabled={!value.includes(o)&&!!multi&&!!max&&value.length>=max} onClick={()=>toggle(o)} className={color?'flex min-w-0 flex-col items-center gap-1 text-[12px] disabled:opacity-35':`min-h-10 rounded-2xl px-1 py-2 text-[12px] disabled:opacity-35 ${value.includes(o)?'chip-on':'chip'}`}>
        {color&&<span className={`grid aspect-square w-full max-w-12 place-items-center rounded-full border-2 ${value.includes(o)?'border-gold ring-2 ring-gold':'border-mauve/60'}`} style={{background:COLORS[o]||'#746578'}}><span className="grid h-5 w-5 place-items-center rounded-full bg-ink text-white" style={{visibility:value.includes(o)?'visible':'hidden'}}>✓</span></span>}
        <span>{o}</span>
      </button>)}
    </div>
    {!!hiddenSelected.length&&<div className="mt-2 text-xs text-mauve">其他已選：{hiddenSelected.map(o=><button key={o} type="button" className="chip-on m-1 rounded-full px-2 py-1" onClick={()=>toggle(o)} aria-label={`取消選擇${o}`}>{o} ×</button>)}</div>}
    {collapse&&all.length>8&&<button type="button" className="mt-3 text-[13px] text-gold-soft underline underline-offset-4" aria-expanded={expanded} aria-controls={region} onClick={()=>setExpanded(v=>!v)}>{expanded?'收起其他選項':'顯示更多選項'}</button>}
  </div>;
}
