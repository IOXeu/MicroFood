function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
export async function onRequestPost(context){
 const {env,request}=context;let b;try{b=await request.json()}catch{return json({error:'Corpo inválido.'},400)}
 const merchantId=String(b.merchantId||''),qr=String(b.qrCode||''),table=String(b.tableNumber||'').trim(),name=String(b.customerName||'').trim();
 const items=Array.isArray(b.items)?b.items:[];
 const orderType=b.orderType==='delivery'?'delivery':'pickup';
 if(!merchantId||!items.length)return json({error:'Pedido inválido.'},400);
 const store=await env.DB.prepare('SELECT * FROM store_settings WHERE merchant_id=?1 AND is_published=1').bind(merchantId).first();
 if(!store)return json({error:'Loja não disponível.'},404);
 if(qr){const t=await env.DB.prepare('SELECT table_number FROM store_tables WHERE merchant_id=?1 AND code=?2 AND is_active=1').bind(merchantId,qr).first();if(!t)return json({error:'Mesa inválida.'},403)}
 let total=0;const lines=[];
 for(const i of items){const p=await env.DB.prepare('SELECT name,price_cents FROM store_products WHERE id=?1 AND merchant_id=?2 AND is_active=1').bind(String(i.id||''),merchantId).first();if(!p)continue;const qty=Math.max(1,Math.min(50,Number(i.qty)||1));total+=p.price_cents*qty;lines.push(`${qty}x ${p.name} — ${new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(p.price_cents*qty/100)}`)}
 if(!lines.length)return json({error:'Nenhum item válido no pedido.'},400);
 let courierId=null,courierFee=0,distance=null;
 if(orderType==='delivery'){
  courierId=b.courierId?String(b.courierId):null;courierFee=Math.max(0,Math.round(Number(b.courierFeeCents)||0));distance=b.distanceKm!=null?Number(b.distanceKm):null;
  if(!courierId)return json({error:'Escolha um entregador para a entrega.'},400);
  const c=await env.DB.prepare('SELECT id,display_name,base_fee_cents,base_distance_km,extra_fee_per_km_cents,max_distance_km FROM couriers WHERE id=?1 AND is_active=1').bind(courierId).first();
  if(!c)return json({error:'Entregador indisponível.'},404);
  const expected=distance!=null&&distance<=c.base_distance_km?c.base_fee_cents:c.base_fee_cents+Math.ceil((distance||0)-c.base_distance_km)*c.extra_fee_per_km_cents;
  if(courierFee!==expected)return json({error:'Valor da entrega inválido. Consulte novamente.'},400);
  total+=courierFee;
 }
 const id=crypto.randomUUID();
 await env.DB.prepare('INSERT INTO store_orders (id,merchant_id,table_number,customer_name,items_json,total_cents,order_type,status,courier_id,courier_fee_cents,distance_km,delivery_cep) VALUES (?1,?2,?3,?4,?5,?6,?7,\'sent\',?8,?9,?10,?11)')
 .bind(id,merchantId,table,name,JSON.stringify(lines),total,orderType,courierId,courierFee,distance,String(b.deliveryCep||'').replace(/\D/g,'')).run();
 const money=v=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v/100);
 const text=[`*${store.store_name||'Novo pedido'}`,table?`Mesa: ${table}`:(orderType==='pickup'?'Retirada na loja':'Entrega'),name?`Cliente: ${name}`:'',...lines,''];
 if(orderType==='delivery'&&courierFee)text.push(`Entrega: ${money(courierFee)}${distance?` (${distance} km)`:''}`);
 text.push(`*Total: ${money(total)}*`);
 const phone=String(store.whatsapp_number||'').replace(/\D/g,'');
 if(!phone)return json({ok:true,orderId:id,whatsappUrl:null,message:'Loja sem WhatsApp configurado.'});
 return json({ok:true,orderId:id,whatsappUrl:`https://wa.me/${phone}?text=${encodeURIComponent(text.join('\n'))}`})}
