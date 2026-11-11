import { api } from './api';
import { makeThumbnail } from './imageProcessing';
/** At most one decode at a time, only while visible/online; yields between jobs. No all-HD preload. */
export function startThumbnailMaintenance() {
  let stopped=false,timer:ReturnType<typeof setTimeout>,controller:AbortController|undefined;
  async function next() {
    let delay=15000;
    try {
      if(stopped||document.visibilityState!=='visible'||!navigator.onLine)return;
      const {job}=await api<{job:{image_id:string;lease:string}|null}>('/api/thumbnails/jobs/claim',{method:'POST'});
      if(!job){delay=120000;return;}
      if(stopped)return;
      controller=new AbortController();
      const path=`/api/thumbnails/jobs/${job.image_id}?lease=${encodeURIComponent(job.lease)}`;
      const timeout=setTimeout(()=>controller?.abort(),45000);
      try {
        const source=await fetch(path,{signal:controller.signal,credentials:'same-origin'});
        if(!source.ok) {if(source.status===429)delay=3600000;throw new Error('thumbnail_source_failed');}
        const sha=source.headers.get('x-source-sha')!;
        const thumbnail=await makeThumbnail(await source.blob());
        if(stopped)return;
        const result=await fetch(path,{method:'PUT',credentials:'same-origin',signal:controller.signal,
          headers:{'content-type':'image/webp','x-requested-with':'ai-wardrobe','x-source-sha':sha},body:thumbnail});
        if(!result.ok)throw new Error('thumbnail_save_failed');
        window.dispatchEvent(new CustomEvent('aw:thumbnail-ready',{detail:job.image_id}));
      } finally {clearTimeout(timeout);}
    } catch {delay=Math.max(delay,60000);} finally {if(!stopped)timer=setTimeout(next,delay);}
  }
  timer=setTimeout(next,15000);
  return ()=>{stopped=true;clearTimeout(timer);controller?.abort();};
}
