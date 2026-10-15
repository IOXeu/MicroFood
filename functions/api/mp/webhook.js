// Pages Function: POST /api/mp/webhook
const MP_API = 'https://api.mercadopago.com';
const SUBSCRIPTION_DAYS = 30;

function mpToken(env) {
  return env.Access_Token || env.MP_ACCESS_TOKEN || '';
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function secureEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) mismatch |= (left[i] || 0) ^ (right[i] || 0);
  return mismatch === 0;
}

async function validMpSignature(request, url, secret) {
  const header = request.headers.get('x-signature') || '';
  const parts = Object.fromEntries(header.split(',').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const requestId = request.headers.get('x-request-id') || '';
  let dataId = url.searchParams.get('data.id') || '';
  if (/^[A-Za-z0-9]+$/.test(dataId)) dataId = dataId.toLowerCase();
  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
  return secureEqual(expected, v1.toLowerCase());
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

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const secret = env.MP_WEBHOOK_SECRET;
  const token = mpToken(env);
  if (!secret || !token) return error('Webhook não configurado', 503);

  if (!await validMpSignature(request, url, secret)) return error('Assinatura inválida', 401);

  let body = {};
  try {
    body = await readJson(request, 16384);
  } catch { /* body opcional */ }

  const type = url.searchParams.get('type') || url.searchParams.get('topic') || body?.type || body?.topic;
  if (type !== 'payment') return json({ ok: true, ignored: type || 'sem tipo' });

  const paymentId = String(url.searchParams.get('data.id') || body?.data?.id || '').trim();
  if (!/^\d{1,20}$/.test(paymentId)) return error('Pagamento inválido', 422);

  const response = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    console.error('Falha ao consultar pagamento no Mercado Pago:', paymentId, response.status);
    return error('Não foi possível consultar o pagamento', 502);
  }

  const payment = await response.json();
  if (payment.status !== 'approved') return json({ ok: true, status: payment.status });

  const merchantId = Number(payment.external_reference);
  if (!Number.isSafeInteger(merchantId) || merchantId < 1)
    return json({ ok: true, ignored: 'sem referência de comerciante' });

  if (payment.currency_id !== 'BRL') return json({ ok: true, ignored: 'moeda diferente de BRL' });

  const subscription = await env.DB.prepare(
    'SELECT amount_cents, paid_until FROM subscriptions WHERE merchant_id = ?'
  ).bind(merchantId).first();
  if (!subscription) return json({ ok: true, ignored: 'assinatura não encontrada' });

  const amountCents = Math.round(Number(payment.transaction_amount) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents < Number(subscription.amount_cents)) {
    console.error('Valor pago menor que a assinatura:', paymentId, amountCents, subscription.amount_cents);
    return json({ ok: true, ignored: 'valor menor que o da assinatura' });
  }

  const already = await env.DB.prepare(
    'SELECT 1 AS found FROM payment_events WHERE external_id = ?'
  ).bind(paymentId).first();
  if (already) return json({ ok: true, duplicate: true });

  const today = new Date().toISOString().slice(0, 10);
  const base = subscription.paid_until && subscription.paid_until > today ? subscription.paid_until : today;
  const paidUntil = addDays(base, SUBSCRIPTION_DAYS);

  const payload = JSON.stringify({
    method: 'mercado_pago',
    payment_id: paymentId,
    payment_type: payment.payment_type_id,
    paid_until: paidUntil
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payment_events (merchant_id, provider, external_id, status, amount_cents, payload) VALUES (?, 'mercado_pago', ?, 'paid', ?, ?)`
      ).bind(merchantId, paymentId, amountCents, payload),
      env.DB.prepare(
        `UPDATE subscriptions SET status = 'active', paid_until = ?, mercado_pago_payment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE merchant_id = ?`
      ).bind(paidUntil, paymentId, merchantId),
      env.DB.prepare(
        `UPDATE merchants SET plan = 'monthly', status = 'active', next_billing_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(paidUntil, merchantId)
    ]);
  } catch (err) {
    if (String(err).toLowerCase().includes('unique')) return json({ ok: true, duplicate: true });
    console.error('Falha ao registrar pagamento do Mercado Pago:', err);
    return error('Não foi possível registrar o pagamento', 500);
  }

  return json({ ok: true, merchantId, paidUntil });
}
