function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
const RULES=`Voce e o moderador automatico do mural "Procura-se & Oportunidades" de uma plataforma para lojas de comida, fornecedores e entregadores autonomos no Brasil.

PERMITIDO: procura-se entregador; entregador disponivel; procura-se fornecedor; fornecedor disponivel; venda/troca de equipamento ou insumos ligados a comida; vagas ligadas a lanchonete, restaurante, doceria ou delivery.

PROIBIDO: ofensa, ameaça, discurso de odio, assedio, conteudo sexual, violencia, autolesao, drogas, armas, apostas, esquemas de dinheiro facil, piramide, emprestimo abusivo, golpe, dados sensiveis como CPF/RG/cartao/senha/endereco completo de terceiros, conteudo sem relacao com comida/fornecimento/entrega, contato que nao seja WhatsApp, spam ou repeticao excessiva.

Responda SOMENTE com JSON valido:
{"approved":true,"reason":"..."} ou {"approved":false,"reason":"..."}`;
export async function onRequestGet(context){
 const rows=await context.env.DB.prepare("SELECT id,ad_type,title,description,city,region,whatsapp_number,created_at,expires_at FROM classified_ads WHERE status='approved' AND expires_at>datetime('now') ORDER BY created_at DESC LIMIT 100").all();
 return json({ads:rows.results||[]})}
export async function onRequestPost(context){
 const {env,request}=context;let b;try{b=await request.json()}catch{return json({error:'Corpo inválido.'},400)}
 const adType=String(b.adType||''),title=String(b.title||'').trim(),description=String(b.description||'').trim(),city=String(b.city||'').trim(),region=String(b.region||'').trim(),whatsapp=String(b.whatsappNumber||'').replace(/\D/g,'');
 if(!['procura_entregador','entregador_disponivel','procura_fornecedor','fornecedor_disponivel','vendo'].includes(adType))return json({error:'Tipo inválido.'},400);
 if(!title||!description||whatsapp.length<10)return json({error:'Preencha título, descrição e WhatsApp válido.'},400);
 const key=env.OPENAI_API_KEY;if(!key)return json({error:'Moderação por IA não configurada.'},500);
 let flagged=true,categories='';
 try{
  const r=await fetch('https://api.openai.com/v1/moderations',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model:'omni-moderation-latest',input:`${title}\n${description}`})});
  const d=await r.json().catch(()=>null);
  const res=d?.results?.[0];
  if(!res)return json({error:'Não foi possível analisar o anúncio.'},502);
  flagged=!!res.flagged;categories=Object.entries(res.categories||{}).filter(([,v])=>v).map(([k])=>k).join(',');
 }catch{return json({error:'Falha ao analisar o anúncio.'},502)}
 const id=crypto.randomUUID();
 if(flagged){
  await env.DB.prepare("INSERT INTO classified_ads (id,author_merchant_id,author_name,ad_type,title,description,city,region,whatsapp_number,status,ai_flagged,ai_categories) VALUES (?1,'anonymous','',?2,?3,?4,?5,?6,?7,'rejected',1,?8)").bind(id,adType,title,description,city,region,whatsapp,categories).run();
  return json({published:false,reason:'Conteúdo fora das normas.'})
 }
 await env.DB.prepare("INSERT INTO classified_ads (id,author_merchant_id,author_name,ad_type,title,description,city,region,whatsapp_number,status,ai_flagged,ai_categories) VALUES (?1,'anonymous','',?2,?3,?4,?5,?6,?7,'approved',0,'')").bind(id,adType,title,description,city,region,whatsapp).run();
 return json({published:true,adId:id})}
