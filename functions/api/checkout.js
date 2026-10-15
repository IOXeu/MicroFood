// Pages Function: POST /api/checkout
const MP_API = 'https://api.mercadopago.com';

function mpToken(env) {
  return env.Access_Token || env.MP_ACCESS_TOKEN || '';
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function readJson(request, maxBytes = 32768) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return error('Origem não autorizada', 403);

  const token = mpToken(env);
  if (!token) return error('Pagamento online ainda não está configurado', 503);

  let body;
  try {
    body = await readJson(request, 4096);
  } catch {
    return error('JSON inválido');
  }

  const merchantId = Number(body?.merchantId);
  const email = cleanString(body?.email, 160).toLowerCase();
  if (!Number.isSafeInteger(merchantId) || merchantId < 1 || !email)
    return error('Dados inválidos', 422);

  const row = await env.DB.prepare(`
    SELECT m.id, m.business_name, m.email, s.amount_cents
    FROM merchants m JOIN subscriptions s ON s.merchant_id = m.id
    WHERE m.id = ?
  `).bind(merchantId).first();

  if (!row || String(row.email).toLowerCase() !== email)
    return error('Cadastro não encontrado', 404);

  const url = new URL(request.url);
  const preference = {
    items: [{
      id: `assinatura-${row.id}`,
      title: 'Assinatura MicroFoodBR (30 dias)',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Number(row.amount_cents) / 100
    }],
    payer: { email: row.email },
    external_reference: String(row.id),
    notification_url: `${url.origin}/api/mp/webhook`,
    back_urls: { success: url.origin, pending: url.origin, failure: url.origin },
    statement_descriptor: 'MICROFOODBR'
  };

  const response = await fetch(`${MP_API}/checkout/preferences`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(preference)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.init_point) {
    console.error('Mercado Pago recusou a criação do checkout:', response.status, JSON.stringify(data).slice(0, 500));
    return error('Não foi possível iniciar o pagamento agora', 502);
  }

  return json({ url: data.init_point });
}
