function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
async function session(context){const {env,request}=context;const r=await fetch(new URL('/api/auth/me',request.url),{headers:{cookie:request.headers.get('cookie')||''}});if(!r.ok)return null;const d=await r.json().catch(()=>null);return d&&d.authenticated?d:null}
export async function onRequestGet(context){const s=await session(context);if(!s)return json({error:'Não autorizado.'},401);
 const rows=await context.env.DB.prepare(`SELECT o.*,c.display_name AS courier_name,c.phone AS courier_phone FROM store_orders o LEFT JOIN couriers c ON c.id=o.courier_id WHERE o.merchant_id=?1 ORDER BY o.created_at DESC LIMIT 100`).bind(s.merchant.id).all();
 return json({orders:rows.results||[]})}
export async function onRequestPatch(context){const s=await session(context);if(!s)return json({error:'Não autorizado.'},401);
 let b;try{b=await context.request.json()}catch{return json({error:'Corpo inválido.'},400)}
 const allowed=['sent','preparing','ready','delivered'];
 if(!b.id||!allowed.includes(b.status))return json({error:'Pedido ou status inválido.'},400);
 await context.env.DB.prepare('UPDATE store_orders SET status=?2 WHERE id=?1 AND merchant_id=?3').bind(b.id,b.status,s.merchant.id).run();
 return json({ok:true})}
