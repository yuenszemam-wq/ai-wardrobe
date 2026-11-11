import { WardrobeImage } from "./WardrobeImage";
import { useEffect, useState } from 'react';
import { api, Garment, GarmentImage, imageUrl } from '../api';
import { Button, Sheet, Spinner, toast } from './ui';

export interface SplitResult { garment: Garment; source: Garment; moved_image_ids: string[] }
export function SplitSheet({ id, onClose, onSplit }: { id:string; onClose:()=>void; onSplit:(r:SplitResult)=>void }) {
  const [garment,setGarment]=useState<Garment|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{let alive=true;api<Garment>(`/api/garments/${id}`).then(g=>{if(alive)setGarment(g)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[id]);
  const images=garment?.images||[];
  function root(image:GarmentImage) {
    const seen=new Set<string>();
    while(image.derived_from && !seen.has(image.id)) {
      seen.add(image.id); const parent=images.find(i=>i.id===image.derived_from);if(!parent)break;image=parent;
    }
    return image.id;
  }
  const groups=new Map<string,GarmentImage[]>();
  for(const image of images){const id=root(image);groups.set(id,[...(groups.get(id)||[]),image]);}
  async function split() {
    setBusy(true);setError('');
    try {const result=await api<SplitResult>(`/api/garments/${id}/split`,{method:'POST',json:{image_ids:selected}});onSplit(result);toast('已拆成新衣物，等待 AI 辨認');}
    catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  return <Sheet title="拆開圖片" onClose={()=>{if(!busy)onClose()}}>
    <p className="text-sm text-mauve">勾選要移到新衣物的圖片。相關去背圖及縮圖會一起移動；原衣物至少保留一組。新衣物的資料可重新填寫或交給 AI 辨認。</p>
    {error&&<p role="alert" className="my-3 text-wine">{error}</p>}
    {!garment&&!error?<Spinner/>:<div className="my-4 grid grid-cols-2 gap-3">{[...groups].map(([root,group],index)=>{
      const image=group.find(i=>i.is_primary&&!/heic|heif/.test(i.mime_type))||group.find(i=>i.image_type==='processed')||group.find(i=>i.image_type!=='thumbnail'&&!/heic|heif/.test(i.mime_type))||group.find(i=>i.image_type==='thumbnail');
      return <label key={root} className={`rounded-xl border p-2 ${selected.includes(root)?'border-amethyst':'border-gold'}`}>
        <input type="checkbox" disabled={busy} checked={selected.includes(root)} onChange={e=>setSelected(v=>e.target.checked?[...v,root]:v.filter(x=>x!==root))}/>
        <span className="ml-2 text-sm">圖片組 {index+1}</span>
        {image&&<WardrobeImage src={imageUrl(image.id)} alt={`圖片組 ${index+1}`} className="mt-2 h-36 w-full object-contain"/>}
      </label>;
    })}</div>}
    {garment&&groups.size<2&&<p className="my-3 text-sm">只有一組原圖及衍生圖，無需拆開。</p>}
    <Button disabled={busy||!selected.length||selected.length===groups.size} onClick={split}>{busy?'拆開中…':`拆成新衣物${selected.length?`（${selected.length} 組）`:''}`}</Button>
  </Sheet>;
}
