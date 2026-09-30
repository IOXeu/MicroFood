function unauthorized() {
  return new Response(JSON.stringify({ error: 'Não autorizado' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export async function onRequestGet({ request, env }) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return unauthorized()

  const { results } = await env.DB.prepare(`
    SELECT m.id, m.business_name, m.owner_name, m.email, m.city, m.state,
           m.plan, m.status, m.trial_ends_at, m.next_billing_at,
           s.status AS subscription_status, s.paid_until
    FROM merchants m
    LEFT JOIN subscriptions s ON s.merchant_id = m.id
    ORDER BY m.created_at DESC
  `).all()

  return Response.json({ merchants: results })
}

export async function onRequestPost({ request, env }) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return unauthorized()

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const required = ['businessName', 'ownerName', 'email', 'city', 'state']
  if (required.some((field) => typeof body[field] !== 'string' || !body[field].trim())) {
    return Response.json({ error: 'Preencha os campos obrigatórios' }, { status: 422 })
  }

  const trialEndsAt = new Date(Date.now() + 7 * 86400000).toISOString()
  const result = await env.DB.prepare(`
    INSERT INTO merchants (business_name, owner_name, email, phone, city, state, trial_ends_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(body.businessName.trim(), body.ownerName.trim(), body.email.trim().toLowerCase(), body.phone?.trim() || null, body.city.trim(), body.state.trim().toUpperCase(), trialEndsAt).run()

  return Response.json({ id: result.meta.last_row_id, trialEndsAt }, { status: 201 })
}
