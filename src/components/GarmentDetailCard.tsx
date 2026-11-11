import { WardrobeImage } from "./WardrobeImage";
import { Taxonomy } from '../../shared/taxonomy';
import { AI_STATUS_LABEL, displayName, Garment, imageUrl, STATUS_LABEL } from '../api';
import { Link, money } from './ui';

export function GarmentDetailCard({g,tax,selected,onSelect}:{g:Garment;tax:Taxonomy;selected?:boolean;onSelect?:()=>void}) {
  const src=imageUrl(g.thumb_image_id||g.primary_image_id);
  const attrs=g.attributes||{};
  const text=(v:unknown)=>Array.isArray(v)?v.join('、'):v==null?'':String(v);
  const detailAttrs=Object.entries(attrs).filter(([k,v])=>!['original_name','source_url'].includes(k)&&text(v));
  const summary=[g.category,g.subcategory,g.style,g.season].filter(Boolean).join(' · ');
  return <article className={`flow-root rounded-2xl border bg-plum p-3 text-[12px] leading-relaxed ${selected?'border-gold ring-1 ring-gold':'border-gold/35'}`}>
    <Link to={`/g/${g.id}`} className="float-left mr-3 mb-2 block w-24" aria-label={`查看${displayName(g)}`}>
      <div className="arch arch-base aspect-[3/4] overflow-hidden">{src?<WardrobeImage src={src} alt={displayName(g)} loading="lazy" className="h-full w-full object-contain p-2"/>:<span className="block pt-12 text-center text-mauve">未有圖片</span>}</div>
    </Link>
    <div className="flex items-start justify-between gap-2">
      <Link to={`/g/${g.id}`} className="min-w-0 break-words font-serif text-[15px] font-bold text-gold-soft">{displayName(g)}</Link>
      {onSelect&&<input type="checkbox" aria-label={`選擇${displayName(g)}`} checked={!!selected} onChange={onSelect} className="mt-1 h-5 w-5 shrink-0 accent-amethyst"/>}
    </div>
    {text(attrs.original_name)&&<p className="break-words text-mauve">{text(attrs.original_name)}</p>}
    {(g.brand||g.price!=null)&&<p className="break-words">{[g.brand,g.price!=null?`HK${money(g.price)}`:''].filter(Boolean).join(' · ')}</p>}
    {summary&&<p className="text-mauve">{summary}</p>}
    {(g.primary_color||g.secondary_colors?.length>0)&&<p>{g.primary_color&&<span className="mr-3"><span className="text-mauve">主色 </span>{g.primary_color}</span>}{g.secondary_colors?.length>0&&<span><span className="text-mauve">次色 </span>{g.secondary_colors.join('、')}</span>}</p>}
    <div>{detailAttrs.map(([k,v])=><span key={k} className="mr-3 inline"><span className="text-mauve">{tax.attributes.find(a=>a.id===k)?.name||k} </span>{text(v)} </span>)}</div>
    {g.pattern&&<p className="break-words"><span className="text-mauve">圖案 </span>{g.pattern}</p>}
    {g.notes&&<p className="whitespace-pre-wrap break-words"><span className="text-mauve">備註 </span>{g.notes}</p>}
    <p className="mt-1 text-[11px] text-mauve">{[STATUS_LABEL[g.status],g.ai_status&&g.ai_status!=='done'?AI_STATUS_LABEL[g.ai_status]:'',g.is_favorite?'♥ 已收藏':'',g.created_at?new Date(g.created_at).toLocaleDateString('zh-HK'):''].filter(Boolean).join(' · ')}</p>
    {typeof attrs.source_url==='string'&&/^https?:\/\//i.test(attrs.source_url)&&<a href={attrs.source_url} target="_blank" rel="noopener noreferrer" className="break-all text-gold-soft underline">{attrs.source_url}</a>}
  </article>;
}
