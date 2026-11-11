import { api } from './api';
import { makeThumbnail } from './imageProcessing';

/** Foreground-only free-plan backfill: one small WebP at a time; no HD grid preload. */
export function startThumbnailMaintenance() {
  let stopped=false,timer:ReturnType<typeof setTimeout>,controller:AbortController|undefined;
  async function next() {
    let delay=15000;
    let job:{image_id:string;lease:string}|null=null;
    let alreadyReleased=false;
    try {
      if(stopped||document.visibilityState!=='visible'||!navigator.onLine)return;
      const claimed=await api<{job:{image_id:string;lease:string}|null}>('/api/thumbnails/jobs/claim',{method:'POST'});
      job=claimed.job;
      if(!job){delay=120000;return;}
      if(stopped)return;
      controller=new AbortController();
      const path=`/api/thumbnails/jobs/${job.image_id}?lease=${encodeURIComponent(job.lease)}`;
      const timeout=setTimeout(()=>controller?.abort(),90000);
      try {
        const source=await fetch(path,{signal:controller.signal,credentials:'same-origin'});
        if(!source.ok) {
          if(source.status===429){alreadyReleased=true;delay=3600000;}
          throw new Error(`thumbnail_source_http_${source.status}`);
        }
        const sha=source.headers.get('x-source-sha');
        if(!sha)throw new Error('thumbnail_source_sha_missing');
        const thumbnail=await makeThumbnail(await source.blob());
        if(stopped)return;
        const result=await fetch(path,{method:'PUT',credentials:'same-origin',signal:controller.signal,
          headers:{'content-type':'image/webp','x-requested-with':'ai-wardrobe','x-source-sha':sha},body:thumbnail});
        if(!result.ok)throw new Error(`thumbnail_save_http_${result.status}`);
        window.dispatchEvent(new CustomEvent('aw:thumbnail-ready',{detail:job.image_id}));
      } finally {clearTimeout(timeout);}
    } catch(e) {
      delay=Math.max(delay,60000);
      // Before this fix, Safari errors were swallowed and leases looked permanently 'working'.
      // The signed-in browser now checkpoints failures, releases the lease and surfaces a reason.
      if(job&&!alreadyReleased) {
        const path=`/api/thumbnails/jobs/${job.image_id}/fail?lease=${encodeURIComponent(job.lease)}`;
        try {await api(path,{method:'POST',json:{reason:e instanceof Error?e.message:'browser_encode_failed'}});}
        catch { /* The lease may have expired or the app may have logged out. */ }
      }
    } finally {if(!stopped)timer=setTimeout(next,delay);}
  }
  timer=setTimeout(next,15000);
  return ()=>{stopped=true;clearTimeout(timer);controller?.abort();};
}
