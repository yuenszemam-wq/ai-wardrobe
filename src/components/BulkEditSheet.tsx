import { AttributeChoices, BrandInput } from "./GarmentChoices";
import { useState } from 'react';
import { isColumnAttribute } from '../../shared/taxonomy';
import { api, Garment, STATUS_LABEL } from '../api';
import { useTaxonomy } from '../taxonomy';
import { Button, inputCls, Sheet } from './ui';

export function BulkEditSheet({ garments, onClose, onUpdated }: { garments:Garment[]; onClose:()=>void; onUpdated:(ids:string[])=>void }) {
  const tax=useTaxonomy();
  const [modes,setModes]=useState<Record<string,string>>({});
  const [values,setValues]=useState<Record<string,string|string[]>>({});
  const [progress,setProgress]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const fields=[
    {id:'name',name:'衣物名稱'}, {id:'original_name',name:'名稱原文'}, {id:'brand',name:'品牌'},
    {id:'category',name:'主分類',options:tax.categories.map(c=>c.name)},
    {id:'subcategory',name:'子分類',options:tax.categories.filter(c=>!values.category||c.name===values.category).flatMap(c=>c.subs.map(s=>s.name))},
    ...tax.attributes.map(a=>({id:a.id,name:a.name,options:a.options.map(o=>o.name),multi:a.multi,max:a.max_select})),
    {id:'price',name:'價錢（HK$）'}, {id:'pattern',name:'圖案描述'}, {id:'notes',name:'備註'},
    {id:'status',name:'入庫狀態',options:Object.values(STATUS_LABEL)},
    {id:'is_favorite',name:'收藏標記',options:['收藏','不收藏']},
    {id:'source_url',name:'連結'},
  ];
  const changed=fields.filter(f=>modes[f.id]);
  async function save(){
    setError('');
    const patch:Record<string,unknown>={},attrs:Record<string,unknown>={};
    for(const field of changed){
      const clear=modes[field.id]==='clear';
      const value=clear?null:values[field.id];
      if(!clear&&(value===undefined||value===''||(Array.isArray(value)&&!value.length))){setError(`請填寫「${field.name}」，或明確選擇清空`);return;}
      if(['original_name','source_url'].includes(field.id)||(tax.attributes.some(a=>a.id===field.id)&&!isColumnAttribute(field.id))) attrs[field.id]=value;
      else patch[field.id]=field.id==='is_favorite'?value==='收藏':field.id==='status'?Object.keys(STATUS_LABEL).find(k=>STATUS_LABEL[k]===value):value;
    }
    if(Object.keys(attrs).length)patch.attributes=attrs;
    if(!Object.keys(patch).length)return;
    setBusy(true);
    try{
      // 伺服器每次最多 100 件：按安全批次逐批執行並顯示進度
      const results:{id:string;ok:boolean;error?:string}[]=[];
      for(let i=0;i<garments.length;i+=100){
        setProgress(`${Math.min(i+100,garments.length)}／${garments.length}`);
        const r=await api<{results:{id:string;ok:boolean;error?:string}[]}>('/api/garments/bulk-edit',{method:'POST',json:{garment_ids:garments.slice(i,i+100).map(g=>g.id),set:patch}});
        results.push(...r.results);
      }
      setProgress('');
      const ok=results.filter(x=>x.ok).map(x=>x.id),failed=results.filter(x=>!x.ok);
      onUpdated(ok);
      if(failed.length)setError(`已更新 ${ok.length} 件；${failed.length} 件未成功：${failed.map(x=>`${garments.find(g=>g.id===x.id)?.name||x.id}：${x.error}`).join('；')}。可重試剩餘項目。`);
      else onClose();
    }catch(e){setError((e as Error).message)}finally{setBusy(false);setProgress('')}
  }
  return <Sheet title={`批量修改（${garments.length} 件）`} onClose={()=>{if(!busy)onClose()}}>
    <p className="text-sm text-mauve">只修改已勾選的欄位；其他資料及 AI 辨認狀態保持不變。多選屬性會以本次選擇取代原值。更改主分類時，未指定的子分類會清空。</p>
    <div className="my-4 space-y-4">{fields.map(field=><div key={field.id} className="rounded-xl border border-gold/40 p-3">
      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={!!modes[field.id]} onChange={e=>setModes(m=>({...m,[field.id]:e.target.checked?'set':''}))}/>{field.name}</label>
        {modes[field.id]&&!['name','status','is_favorite'].includes(field.id)&&<select aria-label={`${field.name}修改方式`} disabled={busy} className="chip rounded px-2 py-1 text-sm" value={modes[field.id]} onChange={e=>setModes(m=>({...m,[field.id]:e.target.value}))}><option value="set">設為</option><option value="clear">清空</option></select>}
      </div>
      {modes[field.id]==='set'&&<div className="mt-2">{field.id==='brand'?<BrandInput disabled={busy} value={String(values.brand||'')} onChange={brand=>setValues(cur=>({...cur,brand}))}/>: 'options' in field ? <AttributeChoices id={field.id} options={field.options||[]} value={Array.isArray(values[field.id])?values[field.id] as string[]:values[field.id]?[String(values[field.id])]:[]} multi={'multi' in field?field.multi:false} max={'max' in field?field.max:undefined}
        onChange={v=>setValues(cur=>({...cur,[field.id]:'multi' in field&&field.multi?v:v[0]||'',...(field.id==='category'?{subcategory:''}:{})}))}/>
        :<input type={field.id==='source_url'?'url':'text'} aria-label={field.name} disabled={busy} className={inputCls} inputMode={field.id==='price'?'decimal':undefined} value={String(values[field.id]||'')} onChange={e=>setValues(v=>({...v,[field.id]:e.target.value}))}/>}</div>}
      {modes[field.id]==='clear'&&<p className="mt-2 text-sm text-wine">將清空所選衣物的這個欄位</p>}
    </div>)}</div>
    {error&&<p role="alert" className="my-3 text-sm text-wine">{error}</p>}
    <div className="sticky bottom-0 bg-ink p-3"><p className="mb-2 text-xs">將修改 {garments.length} 件：{changed.map(f=>f.name).join('、')||'尚未選擇欄位'}</p><Button disabled={busy||!changed.length||!garments.length} onClick={save}>{busy?`修改中…${progress}`:'套用至所選衣物'}</Button></div>
  </Sheet>;
}
