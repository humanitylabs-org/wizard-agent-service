// Opt-in list windows. Membership is pinned after effective lifecycle projection,
// never guessed from raw SQLite archived flags. No auth or agent discovery here.
import { randomUUID } from 'node:crypto';
import { normalizeFull, clean } from './session-list-view.mjs';
const WEEK = 7 * 864e5;
const priority = new Set(['submitting','queued','running','stopping','waiting_for_approval','unknown','failed','interrupted']);
const time = v => Date.parse(v ?? '');
const first = (...vs) => vs.find(v => Number.isFinite(time(v))) || '';
export const cardTime = s => priority.has(s.status) && !['waiting_for_approval','unknown'].includes(s.status)
  ? first(s.assignedAt,s.requestAt,s.lastUserAt,s.previewRole === 'user' ? s.previewAt : undefined)
  : first(s.previewAt,s.activityAt,s.lastUserAt,s.updatedAt);
export const newestFirst = (a,b) => {
  const x=time(cardTime(a)), y=time(cardTime(b));
  return Number.isFinite(x) !== Number.isFinite(y) ? Number.isFinite(x) ? -1 : 1 : (Number.isFinite(x) ? y-x : 0) || a.title.localeCompare(b.title);
};
export function archiveCandidate(s, now=Date.now()) {
  if (s.hidden || priority.has(s.status) || (s.deferred && !s.archived)) return false;
  const latest=Math.max(...[s.restoredAt,s.assignedAt,s.previewAt,s.requestAt,s.activityAt,s.lastUserAt,s.updatedAt].map(time).filter(Number.isFinite));
  return s.archived || (Number.isFinite(latest) && latest <= now-WEEK);
}
export function clientOverrides(raw) {
  if (!raw) return {};
  if (raw.length > 32000) throw Object.assign(new Error('list overrides too large'),{status:400});
  let value; try { value=JSON.parse(raw); } catch { throw Object.assign(new Error('invalid list overrides'),{status:400}); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Object.assign(new Error('invalid list overrides'),{status:400});
  const out=Object.create(null);
  for(const [id,v] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(id) || !v || typeof v !== 'object') continue;
    out[id]={};
    for(const k of ['archived','deferred']) if(typeof v[k]==='boolean') out[id][k]=v[k];
    if(Number.isFinite(time(v.restoredAt))) out[id].restoredAt=v.restoredAt;
  }
  return out;
}
export function selectWindow(rows, {dispositions={}, overrides={}, now=Date.now(), q=''}={}) {
  const entries=rows.map(raw=>({raw,s:normalizeFull(raw)})).filter(x=>x.s && !x.s.hidden);
  for(const {s} of entries) {
    const d=dispositions[`direct:${s.id}`];
    if(d) { if(d.deferred) s.deferred=true; else s.restoredAt=d.updatedAt; }
    const o=overrides[s.id];
    if(o) {
      // Local restored timestamps expire when a new turn or explicit archive supersedes them.
      const latest=Math.max(...[s.lastUserAt,s.lastAssistantAt,s.activityAt].map(time).filter(Number.isFinite));
      if(o.restoredAt && !s.archived && (!Number.isFinite(latest)||latest<time(o.restoredAt))) s.restoredAt=o.restoredAt;
      for(const k of ['archived','deferred']) if(typeof o[k]==='boolean') s[k]=o[k];
    }
  }
  entries.sort((a,b)=>newestFirst(a.s,b.s));
  const archived=entries.filter(x=>archiveCandidate(x.s,now));
  if(q) {
    const words=q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches=entries.filter(({raw,s})=> {
      const hay=[s.title,s.preview,clean(raw.wizard_request_preview),clean(raw.last_user_message?.content),clean(raw.latest_message?.content),clean(raw.wizard_search_text)].join(' ').toLowerCase();
      return raw.wizard_search_match === true || words.every(w=>hay.includes(w));
    });
    return {rows:matches.map(x=>x.raw), archive_total:archived.length, search_total:matches.length};
  }
  const keep=new Set(archived.slice(0,50).map(x=>x.s.id));
  return {rows:entries.filter(x=>!archiveCandidate(x.s,now)||keep.has(x.s.id)).map(x=>x.raw), archiveRows:archived.map(x=>x.raw), archive_total:archived.length,
    archive_returned:Math.min(50,archived.length), archive_cursor:archived.length>50 ? {after:archived[49].s.id, remaining:archived.length-50} : null};
}
export function createListWindows({ now=Date.now, ttl=30000 }={}) {
  const snapshots=new Map();
  return async function page({params, scope, load, dispositions={}}) {
    const offset=Number(params.get('offset')||0), limit=Math.min(100,Math.max(1,Number(params.get('limit')||100)));
    const signature=JSON.stringify([scope,params.get('window')||'',params.get('q')||'',params.get('overrides')||'']);
    const cursor=params.get('cursor'), cursorParts=cursor?.split(':'), archiveOffset=cursor ? Number(cursorParts?.[1]) : 0;
    if(cursor && (cursorParts.length!==2 || params.has('q') || params.get('window')!=='archive-50' || !Number.isInteger(archiveOffset) || archiveOffset<50)) throw Object.assign(new Error('invalid cursor'),{status:400});
    const id=cursor ? cursorParts[0] : params.get('snapshot'), at=now();
    let snap=(offset>0 || cursor) && snapshots.get(id);
    if((offset>0 || cursor) && (!snap || snap.expiresAt<at || snap.signature!==signature)) throw Object.assign(new Error('session listing snapshot expired'),{status:409});
    if(!snap) {
      const selected=selectWindow(await load(),{dispositions,overrides:clientOverrides(params.get('overrides')),now:at,q:params.get('q')||''});
      snap={...selected,id:randomUUID(),signature,expiresAt:now()+ttl};
      snapshots.set(snap.id,snap);
      for(const [key,v] of snapshots) if(v.expiresAt<at || snapshots.size>32) snapshots.delete(key);
    }
    const {rows,archiveRows,...meta}=snap;
    const data=cursor ? archiveRows.slice(archiveOffset,archiveOffset+50) : rows.slice(offset,offset+limit);
    const nextArchive=cursor ? archiveOffset+data.length : 50;
    return {object:'list',data,limit,offset,has_more:cursor ? false : offset+data.length<rows.length,snapshot:snap.id,
      window:'archive-50',window_projected:true,archive_total:meta.archive_total,archive_returned:meta.archive_returned,
      archive_cursor:!params.get('q') && nextArchive<meta.archive_total ? `${snap.id}:${nextArchive}` : null,search_total:meta.search_total};
  };
}
