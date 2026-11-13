/** 手動網格：固定 4×4，儲存為原圖比例偏移，限制翻面及極端拉伸。 */
export const MANUAL_GRID = 4;
export function normalizeManualMesh(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length !== 32 || v.some(x => typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 0.75)) return undefined;
  const a = v.map(x => Math.round(x * 10000) / 10000);
  const pt = (i: number) => [i % 4 / 3 + a[i*2], Math.floor(i / 4) / 3 + a[i*2+1]];
  const cross = (a: number[], b: number[], c: number[]) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for (let y=0;y<3;y++) for(let x=0;x<3;x++) { const i=y*4+x, p=pt(i), q=pt(i+1), s=pt(i+4), t=pt(i+5); if ([cross(p,q,s),cross(q,t,p),cross(t,s,q),cross(s,p,t)].some(c=>c<0.002)) return undefined; }
  return a.some(x=>x!==0) ? a : undefined;
}
export function manualUV(mesh: number[] | undefined, u: number, v: number): [number,number] {
  if (!mesh) return [u,v];
  const x=Math.max(0,Math.min(3,u*3)), y=Math.max(0,Math.min(3,v*3)), i=Math.min(2,Math.floor(x)), j=Math.min(2,Math.floor(y)), s=x-i,t=y-j;
  const k=(j*4+i)*2;
  const d=(c:number)=>mesh[k+c]*(1-s)*(1-t)+mesh[k+2+c]*s*(1-t)+mesh[k+8+c]*(1-s)*t+mesh[k+10+c]*s*t;
  return [u+d(0),v+d(1)];
}
