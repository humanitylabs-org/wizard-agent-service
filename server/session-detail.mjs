// Detail hydration must never reuse a list preview: even legacy previews cap at 1,000.
import { visibleUserRequest, visibleAssistantReply } from './session-truth.mjs';
import { clean } from './session-list-view.mjs';
export async function searchMessageText(fetchPage, query) {
  const words=String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  for (let offset=0; offset<100000; offset+=100) {
    const p=await fetchPage(offset), rows=p.data||p.messages||p.items||[];
    for (const row of rows) {
      const visible=row.role==='user' ? visibleUserRequest(row.content,row.display_kind) : row.role==='assistant' && visibleAssistantReply(row.content,row.display_kind,row.finish_reason);
      if(visible && words.every(w=>clean(row.content).toLowerCase().includes(w))) return row.content;
    }
    if(p.has_more===false || (p.has_more!==true && rows.length<100)) return '';
    if(!rows.length) throw new Error('incomplete search history');
  }
  throw new Error('search history limit reached');
}
export async function fullRetryInput(fetchPage) {
  for (let offset=0; offset<100000; offset+=100) {
    const p=await fetchPage(offset), rows=p.data||p.messages||p.items||[];
    const users=rows.filter(m=>m.role==='user' && visibleUserRequest(m.content,m.display_kind)).sort((a,b)=>Number(b.timestamp||0)-Number(a.timestamp||0));
    if(users.length) return users[0].content;
    if(p.has_more===false || (p.has_more!==true && rows.length<100)) return '';
    if(!rows.length) throw new Error('incomplete retry history');
  }
  throw new Error('retry history limit reached');
}
