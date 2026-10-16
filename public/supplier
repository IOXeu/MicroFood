function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
export async function onRequestGet(context){
 const {env,request}=context;const url=new URL(request.url);
 const merchantId=url.searchParams.get('merchantId');
 if(!merchantId)return json({error:'Fornecedor não informado.'},400);
 const profile=await env.DB.prepare('SELECT merchant_id,company_name,category,description,whatsapp_number,city,delivery_regions,minimum_order_cents,cover_image_url FROM supplier_profiles WHERE merchant_id=?1 AND is_published=1').bind(merchantId).first();
 if(!profile)return json({error:'Catálogo não encontrado ou não publicado.'},404);
 const products=await env.DB.prepare('SELECT id,name,description,unit,price_cents,minimum_quantity,image_url,is_active,category FROM supplier_products WHERE merchant_id=?1 AND is_active=1 ORDER BY sort_order,created_at').bind(merchantId).all();
 return json({profile,products:products.results||[]})}
