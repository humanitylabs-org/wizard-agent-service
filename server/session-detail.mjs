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
// Issue 145, point 2: once the owner's own turns are restored on a history page (their internal_notification kind
// cleared), a restored multipart row still holds the content list. Retry reads text, so give it the owner's words.
const retryPartText = (part) => typeof part === 'string' ? part
  : Array.isArray(part) ? part.map(retryPartText).filter(Boolean).join('\n')
  : !part || typeof part !== 'object' ? ''
  : typeof part.text === 'string' ? (part.text.startsWith('[System:') ? '' : part.text)
  : retryPartText(part.content)
export function ownerRetryRows(page) {
  for (const key of ['data', 'messages', 'items']) for (const row of Array.isArray(page?.[key]) ? page[key] : []) {
    if (row && typeof row === 'object' && row.role === 'user' && !row.display_kind && Array.isArray(row.content)) row.content = retryPartText(row.content)
  }
  return page
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
