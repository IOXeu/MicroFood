function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
export async function onRequestGet(context){
 const {env,request}=context;const url=new URL(request.url);
 const merchantId=url.searchParams.get('merchantId'),qr=url.searchParams.get('qr');
 if(!merchantId)return json({error:'Loja não informada.'},400);
 const store=await env.DB.prepare('SELECT * FROM store_settings WHERE merchant_id=?1 AND is_published=1').bind(merchantId).first();
 if(!store)return json({error:'Loja não encontrada ou não publicada.'},404);
 if(qr){const t=await env.DB.prepare('SELECT id FROM store_tables WHERE merchant_id=?1 AND code=?2 AND is_active=1').bind(merchantId,qr).first();if(!t)return json({error:'QR Code de mesa inválido.'},403)}
 const products=await env.DB.prepare('SELECT id,name,description,price_cents,category,image_url,is_active FROM store_products WHERE merchant_id=?1 AND is_active=1 ORDER BY sort_order,created_at').bind(merchantId).all();
 return json({store,products:products.results||[]})}
