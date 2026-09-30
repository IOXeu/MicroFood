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
  const businessName = body.businessName.trim()
  const slugBase = businessName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'comerciante'
  const slug = `${slugBase}-${Date.now().toString(36)}`
  const email = body.email.trim().toLowerCase()

  try {
    const result = await env.DB.prepare(`
      INSERT INTO merchants (business_name, owner_name, email, phone, city, state, slug, trial_ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(businessName, body.ownerName.trim(), email, body.phone?.trim() || null, body.city.trim(), body.state.trim().toUpperCase(), slug, trialEndsAt).run()

    await env.DB.prepare(`
      INSERT INTO subscriptions (merchant_id, trial_ends_at) VALUES (?, ?)
    `).bind(result.meta.last_row_id, trialEndsAt).run()

    return Response.json({ id: result.meta.last_row_id, slug, trialEndsAt }, { status: 201 })
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) return Response.json({ error: 'Este e-mail já está cadastrado' }, { status: 409 })
    return Response.json({ error: 'Não foi possível concluir o cadastro' }, { status: 500 })
  }
}
