import { ImgHTMLAttributes, useEffect, useRef, useState } from 'react';
import { cachedHighResolution, highResolutionBlob, imageIdOf, thumbnailBlob } from '../imageCache';

export interface WardrobeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  quality?: 'thumbnail'|'high';
  transparentOnly?: boolean;
}
export function hasTransparentPixels(img:HTMLImageElement) {
  const c=document.createElement('canvas'),s=Math.min(1,128/Math.max(img.naturalWidth,img.naturalHeight));
  c.width=Math.max(1,Math.round(img.naturalWidth*s));c.height=Math.max(1,Math.round(img.naturalHeight*s));
  const ctx=c.getContext('2d',{willReadFrequently:true});if(!ctx)return false;
  ctx.drawImage(img,0,0,c.width,c.height);const d=ctx.getImageData(0,0,c.width,c.height).data;
  let clear=false,visible=false;for(let i=3;i<d.length;i+=4){clear ||= d[i]===0;visible ||= d[i]>0;if(clear&&visible)return true;}return false;
}
export function WardrobeImage({src,quality='thumbnail',transparentOnly=false,alt='',className='',style,loading,...rest}:WardrobeImageProps) {
  const host=useRef<HTMLSpanElement>(null);
  const [visible,setVisible]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0),[high,setHigh]=useState(false);
  useEffect(()=>{const ready=(event:Event)=>{if((event as CustomEvent).detail===imageIdOf(src))setRetry(r=>r+1);};window.addEventListener('aw:thumbnail-ready',ready);return()=>window.removeEventListener('aw:thumbnail-ready',ready);},[src]);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    if(!('IntersectionObserver' in window)){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'160px'});
    observer.observe(element);return()=>observer.disconnect();
  },[]);
  const shownSrc=useRef<string|undefined>(undefined),shownUrl=useRef('');
  useEffect(()=>()=>{if(shownUrl.current.startsWith('blob:'))URL.revokeObjectURL(shownUrl.current);},[]);
  const display=(u:string)=>{const prev=shownUrl.current;shownUrl.current=u;setUrl(u);if(prev&&prev!==u&&prev.startsWith('blob:'))setTimeout(()=>URL.revokeObjectURL(prev),1000);};
  useEffect(()=>{
    if(!visible||!src)return;
    // 同一張圖片只是改變畫質時保留目前畫面，不會先變成空白
    let cancelled=false;const urls:string[]=[];if(shownSrc.current!==src){display('');shownSrc.current=src;}setError('');
    const abort=new AbortController();let hd=false;
    async function show(blob:Blob,high=false) {
      if(cancelled||(hd&&!high))return;
      const candidate=URL.createObjectURL(blob);urls.push(candidate);
      const img=new Image();img.src=candidate;await img.decode();
      if(transparentOnly&&!hasTransparentPixels(img))throw new Error('未有透明圖片');
      if(!cancelled&&!(hd&&!high)){if(high)hd=true;display(candidate);setHigh(high);}
    }
    void(async()=>{
      const id=imageIdOf(src);
      if(!id) {if(!cancelled)display(src!);return;}
      // 高清：手機已保存的高清圖直接顯示；否則先顯示縮圖，高清解碼成功後無縫替換
      if(quality==='high'){const local=await cachedHighResolution(src!);if(local){try{await show(local,true);return;}catch{/* 改用網絡 */}}}
      try {await show(await thumbnailBlob(id));}catch(e){if(!cancelled)setError((e as Error).message);}
      if(quality==='high')try {await show(await highResolutionBlob(src!,{signal:abort.signal}),true);if(!cancelled)setError('');}catch(e){if(!cancelled&&!abort.signal.aborted)setError(navigator.onLine?'高清圖片未能載入，已顯示縮圖':'離線：顯示縮圖');}
    })();
    return()=>{cancelled=true;abort.abort();urls.forEach(u=>{if(u!==shownUrl.current)URL.revokeObjectURL(u);});};
  },[src,visible,quality,transparentOnly,retry]);
  return <span ref={host} className={`block ${className}`} style={style} data-quality={url?(high?'high':'thumbnail'):'none'}>
    {url?<img {...rest} src={url} alt={alt} decoding="async" className="h-full w-full object-contain" onError={()=>{display('');setError('圖片解碼失敗');}}/>:
      <span role="img" aria-label={alt||'縮圖準備中'} className="flex h-full w-full items-center justify-center text-center text-[11px] text-mauve">{error||'縮圖準備中'}</span>}
    {error&&<span role="button" data-testid="image-retry" tabIndex={0} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();setRetry(r=>r+1);}}} className="relative z-10 rounded bg-ink px-2 text-[10px] text-gold-soft" title={error} onClick={e=>{e.preventDefault();e.stopPropagation();setRetry(r=>r+1);}}>重試圖片</span>}
  </span>;
}
