const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const SESSION_COOKIE = 'mf_admin_session'
const SESSION_SECONDS = 8 * 60 * 60
const ORDER_STATUSES = new Set(['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'])

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } })
}

function error(message, status = 400, extraHeaders = {}) {
  return json({ error: message }, status, extraHeaders)
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function secureEqual(a, b) {
  const left = new TextEncoder().encode(String(a))
  const right = new TextEncoder().encode(String(b))
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) mismatch |= (left[i] || 0) ^ (right[i] || 0)
  return mismatch === 0
}

function toBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function signSessionPayload(payload, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

async function createSession(secret) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })))
  const signature = toBase64Url(await signSessionPayload(payload, secret))
  return `${payload}.${signature}`
}

function cookieValue(request, name) {
  const prefix = `${name}=`
  const entry = (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : ''
}

async function validSession(request, secret) {
  const value = cookieValue(request, SESSION_COOKIE)
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra) return false
  try {
    const expected = await signSessionPayload(payload, secret)
    if (!secureEqual(expected, fromBase64Url(signature))) return false
    const decoded = new TextDecoder().decode(fromBase64Url(payload))
    const session = JSON.parse(decoded)
    return Number.isInteger(session.exp) && session.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (bearer && secureEqual(bearer, env.ADMIN_TOKEN)) return true
  return validSession(request, env.ADMIN_TOKEN)
}

function sameOrigin(request) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try { return new URL(origin).origin === new URL(request.url).origin } catch { return false }
}

async function readJson(request, maxBytes = 32_768) {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('PAYLOAD_TOO_LARGE')
  try { return JSON.parse(raw) } catch { throw new Error('INVALID_JSON') }
}

function sessionCookie(value, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`
}

async function adminLogin(request, env) {
  if (!sameOrigin(request)) return error('Origem não autorizada', 403)
  if (!env.ADMIN_TOKEN) return error('Configure o segredo ADMIN_TOKEN no Worker antes de entrar', 503)
  let body
  try { body = await readJson(request, 4_096) } catch { return error('Solicitação inválida') }
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!secureEqual(password, env.ADMIN_TOKEN)) return error('Senha incorreta', 401)
  const session = await createSession(env.ADMIN_TOKEN)
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session) })
}

function adminLogout() {
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) })
}

async function getMenu(url, env) {
  const merchantId = Number(url.searchParams.get('merchant_id') ?? url.searchParams.get('merchantId'))
  const category = cleanString(url.searchParams.get('category'), 80)
  const search = cleanString(url.searchParams.get('search'), 100).toLowerCase()
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 50)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const conditions = ['available = 1']
  const params = []
  if (Number.isInteger(merchantId) && merchantId > 0) { conditions.push('merchant_id = ?'); params.push(merchantId) }
  if (category) { conditions.push('category = ?'); params.push(category) }
  if (search) { conditions.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)'); params.push(`%${search}%`, `%${search}%`) }
  const where = conditions.join(' AND ')
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM menu_items WHERE ${where}`).bind(...params).first()
  const result = await env.DB.prepare(`
    SELECT id, merchant_id, name, description, category, price_cents, image_url, available
    FROM menu_items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all()
  return json({ items: result.results, total: Number(totalRow?.total || 0), limit, offset })
}

async function createMerchant(request, env) {
  let body
  try { body = await readJson(request) } catch (err) {
    return err.message === 'PAYLOAD_TOO_LARGE' ? error('Cadastro muito grande', 413) : error('JSON inválido')
  }
  if (cleanString(body?.website, 200) || cleanString(body?.__hp_mf, 200)) return error('Não foi possível concluir o cadastro')
  const businessName = cleanString(body?.businessName, 120)
  const ownerName = cleanString(body?.ownerName, 120)
  const email = cleanString(body?.email, 254).toLowerCase()
  const phone = cleanString(body?.phone, 40)
  const city = cleanString(body?.city, 100)
  const state = cleanString(body?.state, 2).toUpperCase()
  if (!businessName || !ownerName || !email || !city || !state) return error('Preencha os campos obrigatórios', 422)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('E-mail inválido', 422)
  if (!/^[A-Z]{2}$/.test(state)) return error('Informe uma UF válida com duas letras', 422)

  const trialEndsAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const slugBase = businessName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'comerciante'
  const slug = `${slugBase}-${crypto.randomUUID().slice(0, 8)}`
  let merchantId
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO merchants (business_name, owner_name, email, phone, city, state, slug, trial_ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(businessName, ownerName, email, phone || null, city, state, slug, trialEndsAt).run()
    merchantId = inserted.meta.last_row_id
    await env.DB.prepare(`INSERT INTO subscriptions (merchant_id, trial_ends_at) VALUES (?, ?)`)
      .bind(merchantId, trialEndsAt).run()
    return json({ id: merchantId, slug, trialEndsAt }, 201)
  } catch (err) {
    if (merchantId) {
      try { await env.DB.prepare('DELETE FROM merchants WHERE id = ?').bind(merchantId).run() } catch { /* best-effort cleanup */ }
    }
    if (String(err).toLowerCase().includes('unique')) return error('Este e-mail já está cadastrado', 409)
    console.error('Falha ao criar cadastro de comerciante:', err)
    return error('Não foi possível concluir o cadastro', 500)
  }
}

async function listMerchants(request, env) {
  if (!await isAdmin(request, env)) return error('Não autorizado', 401)
  try {
    const { results } = await env.DB.prepare(`
      SELECT m.id, m.business_name, m.owner_name, m.email, m.phone, m.city, m.state,
             m.plan, m.status, m.trial_ends_at, m.next_billing_at,
             s.status AS subscription_status, s.amount_cents, s.trial_ends_at AS subscription_trial_ends_at,
             s.paid_until,
             (SELECT pe.status FROM payment_events pe WHERE pe.merchant_id = m.id ORDER BY pe.received_at DESC LIMIT 1) AS last_payment_status,
             (SELECT pe.received_at FROM payment_events pe WHERE pe.merchant_id = m.id ORDER BY pe.received_at DESC LIMIT 1) AS last_payment_at,
             (SELECT pe.amount_cents FROM payment_events pe WHERE pe.merchant_id = m.id ORDER BY pe.received_at DESC LIMIT 1) AS last_payment_cents
      FROM merchants m LEFT JOIN subscriptions s ON s.merchant_id = m.id
      ORDER BY m.created_at DESC LIMIT 500
    `).all()
    return json({ merchants: results })
  } catch (err) {
    console.error('Falha ao listar comerciantes:', err)
    return error('Não foi possível carregar os comerciantes', 500)
  }
}

async function adminSummary(env) {
  try {
    const now = new Date().toISOString()
    const subscriptionStats = await env.DB.prepare(`
      SELECT COUNT(DISTINCT m.id) AS total_merchants,
        SUM(CASE WHEN s.status = 'trial' AND COALESCE(s.trial_ends_at, m.trial_ends_at) >= ? THEN 1 ELSE 0 END) AS trials,
        SUM(CASE WHEN s.status = 'active' AND s.paid_until IS NOT NULL AND s.paid_until >= ? THEN 1 ELSE 0 END) AS paid_up,
        SUM(CASE WHEN s.status = 'past_due' OR (s.status = 'active' AND s.paid_until IS NOT NULL AND s.paid_until < ?) OR (s.status = 'trial' AND COALESCE(s.trial_ends_at, m.trial_ends_at) < ?) THEN 1 ELSE 0 END) AS overdue
      FROM merchants m LEFT JOIN subscriptions s ON s.merchant_id = m.id
    `).bind(now, now, now, now).first()
    const orderStats = await env.DB.prepare(`
      SELECT COUNT(*) AS total_orders,
        SUM(CASE WHEN status IN ('pending', 'confirmed', 'preparing', 'ready') THEN 1 ELSE 0 END) AS open_orders
      FROM orders
    `).first()
    return json({
      totalMerchants: Number(subscriptionStats?.total_merchants || 0),
      trials: Number(subscriptionStats?.trials || 0),
      paidUp: Number(subscriptionStats?.paid_up || 0),
      overdue: Number(subscriptionStats?.overdue || 0),
      totalOrders: Number(orderStats?.total_orders || 0),
      openOrders: Number(orderStats?.open_orders || 0),
    })
  } catch (err) {
    console.error('Falha ao carregar resumo administrativo:', err)
    return error('Não foi possível carregar o resumo', 500)
  }
}

async function adminOrders(url, env) {
  try {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 25), 1), 50)
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0)
    const q = cleanString(url.searchParams.get('q'), 100)
    const status = cleanString(url.searchParams.get('status'), 30)
    const conditions = []
    const params = []
    if (q) {
      conditions.push(`(o.customer_name LIKE ? OR o.customer_phone LIKE ? OR COALESCE(o.delivery_address, '') LIKE ? OR m.business_name LIKE ?)`)
      const like = `%${q}%`
      params.push(like, like, like, like)
    }
    if (status && ORDER_STATUSES.has(status)) { conditions.push('o.status = ?'); params.push(status) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const from = `FROM orders o JOIN merchants m ON m.id = o.merchant_id ${where}`
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...params).first()
    const { results: orders } = await env.DB.prepare(`
      SELECT o.id, o.merchant_id, o.customer_name, o.customer_phone, o.delivery_address, o.notes,
             o.total_cents, o.status, o.created_at, m.business_name
      ${from} ORDER BY o.created_at DESC LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all()
    const ids = orders.map((order) => order.id)
    let items = []
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(', ')
      const result = await env.DB.prepare(`
        SELECT order_id, menu_item_id, item_name, unit_price_cents, quantity, subtotal_cents
        FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id
      `).bind(...ids).all()
      items = result.results
    }
    const byOrder = new Map()
    for (const item of items) {
      if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, [])
      byOrder.get(item.order_id).push(item)
    }
    return json({ orders: orders.map((order) => ({ ...order, items: byOrder.get(order.id) || [] })), total: Number(totalRow?.total || 0), limit, offset })
  } catch (err) {
    console.error('Falha ao carregar pedidos administrativos:', err)
    return error('Não foi possível carregar os pedidos', 500)
  }
}

async function updateOrder(request, env, orderId) {
  if (!sameOrigin(request)) return error('Origem não autorizada', 403)
  let body
  try { body = await readJson(request, 4_096) } catch { return error('JSON inválido') }
  const status = body?.status
  if (!ORDER_STATUSES.has(status)) return error('Status de pedido inválido', 422)
  try {
    const result = await env.DB.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(status, orderId).run()
    if (!result.meta?.changes) return error('Pedido não encontrado', 404)
    return json({ ok: true, id: orderId, status })
  } catch (err) {
    console.error('Falha ao atualizar pedido:', err)
    return error('Não foi possível atualizar o pedido', 500)
  }
}

async function recordManualPayment(request, env, merchantId) {
  if (!sameOrigin(request)) return error('Origem não autorizada', 403)
  let body
  try { body = await readJson(request, 8_192) } catch { return error('JSON inválido') }
  const paidUntil = cleanString(body?.paidUntil, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidUntil) || Number.isNaN(Date.parse(`${paidUntil}T00:00:00Z`))) {
    return error('Informe uma data válida de pagamento até', 422)
  }
  try {
    const subscription = await env.DB.prepare('SELECT amount_cents FROM subscriptions WHERE merchant_id = ?').bind(merchantId).first()
    if (!subscription) return error('Assinatura não encontrada para este comerciante', 404)
    const amountCents = body?.amountCents == null ? Number(subscription.amount_cents) : Number(body.amountCents)
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100_000_000) return error('Valor inválido', 422)
    const reference = cleanString(body?.reference, 120)
    const note = cleanString(body?.note, 500)
    const externalId = `manual-${crypto.randomUUID()}`
    const payload = JSON.stringify({ method: 'manual', reference, note, paid_until: paidUntil })
    await env.DB.batch([
      env.DB.prepare(`UPDATE subscriptions SET status = 'active', paid_until = ?, updated_at = CURRENT_TIMESTAMP WHERE merchant_id = ?`).bind(paidUntil, merchantId),
      env.DB.prepare(`UPDATE merchants SET plan = 'monthly', status = 'active', next_billing_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(paidUntil, merchantId),
      env.DB.prepare(`INSERT INTO payment_events (merchant_id, provider, external_id, status, amount_cents, payload) VALUES (?, 'manual', ?, 'paid', ?, ?)`).bind(merchantId, externalId, amountCents, payload),
    ])
    return json({ ok: true, merchantId, amountCents, paidUntil, reference })
  } catch (err) {
    console.error('Falha ao registrar pagamento manual:', err)
    return error('Não foi possível registrar o pagamento', 500)
  }
}

async function createOrder(request, env) {
  let body
  try { body = await readJson(request) } catch (err) {
    return err.message === 'PAYLOAD_TOO_LARGE' ? error('Pedido muito grande', 413) : error('JSON inválido')
  }
  const merchantId = Number(body?.merchantId)
  const customerName = cleanString(body?.customerName, 120)
  const customerPhone = cleanString(body?.customerPhone, 40)
  const deliveryAddress = cleanString(body?.deliveryAddress, 500)
  const notes = cleanString(body?.notes, 500)
  if (!Number.isInteger(merchantId) || merchantId < 1 || !customerName || !customerPhone || !Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 20) {
    return error('Informe comerciante, cliente, telefone e itens')
  }
  const quantities = new Map()
  for (const row of body.items) {
    const id = Number(row?.menuItemId)
    const quantity = Number(row?.quantity)
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return error('Produto ou quantidade inválida')
    quantities.set(id, (quantities.get(id) || 0) + quantity)
    if (quantities.get(id) > 20) return error('A quantidade máxima por produto é 20')
  }
  let orderId
  try {
    const ids = [...quantities.keys()]
    const placeholders = ids.map(() => '?').join(', ')
    const { results } = await env.DB.prepare(`
      SELECT id, merchant_id, name, price_cents FROM menu_items
      WHERE merchant_id = ? AND available = 1 AND id IN (${placeholders})
    `).bind(merchantId, ...ids).all()
    const catalog = new Map(results.map((item) => [item.id, item]))
    if (catalog.size !== ids.length) return error('Produto indisponível ou não encontrado', 422)
    let total = 0
    const lines = []
    for (const [id, quantity] of quantities) {
      const item = catalog.get(id)
      const subtotal = item.price_cents * quantity
      if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(total + subtotal)) return error('Total do pedido inválido')
      total += subtotal
      lines.push({ item, quantity, subtotal })
    }
    if (total <= 0) return error('Pedido inválido')
    const inserted = await env.DB.prepare(`
      INSERT INTO orders (merchant_id, customer_name, customer_phone, delivery_address, notes, total_cents)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(merchantId, customerName, customerPhone, deliveryAddress || null, notes || null, total).run()
    orderId = inserted.meta.last_row_id
    const statements = lines.map(({ item, quantity, subtotal }) => env.DB.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_cents, quantity, subtotal_cents)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(orderId, item.id, item.name, item.price_cents, quantity, subtotal))
    await env.DB.batch(statements)
    return json({ id: orderId, totalCents: total, status: 'pending' }, 201)
  } catch (err) {
    if (orderId) {
      try { await env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run() } catch { /* best-effort cleanup */ }
    }
    console.error('Falha ao criar pedido:', err)
    return error('Não foi possível registrar o pedido', 500)
  }
}

async function listOrders(request, env) {
  if (!await isAdmin(request, env)) return error('Não autorizado', 401)
  try {
    const { results } = await env.DB.prepare(`
      SELECT o.id, o.customer_name, o.customer_phone, o.total_cents, o.status,
             o.created_at, m.business_name
      FROM orders o JOIN merchants m ON m.id = o.merchant_id
      ORDER BY o.created_at DESC LIMIT 100
    `).all()
    return json({ orders: results })
  } catch (err) {
    console.error('Falha ao listar pedidos:', err)
    return error('Não foi possível carregar os pedidos', 500)
  }
}

const MP_API = 'https://api.mercadopago.com'
const SUBSCRIPTION_DAYS = 30

function mpToken(env) {
  return env.Access_Token || env.MP_ACCESS_TOKEN || ''
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function validMpSignature(request, url, secret) {
  const header = request.headers.get('x-signature') || ''
  const parts = Object.fromEntries(header.split(',').map((part) => {
    const index = part.indexOf('=')
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]
  }))
  const ts = parts.ts
  const v1 = parts.v1
  if (!ts || !v1) return false
  const requestId = request.headers.get('x-request-id') || ''
  let dataId = url.searchParams.get('data.id') || ''
  if (/^[A-Za-z0-9]+$/.test(dataId)) dataId = dataId.toLowerCase()
  let manifest = ''
  if (dataId) manifest += `id:${dataId};`
  if (requestId) manifest += `request-id:${requestId};`
  manifest += `ts:${ts};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)))
  return secureEqual(expected, v1.toLowerCase())
}

async function createCheckout(request, env, url) {
  if (!sameOrigin(request)) return error('Origem não autorizada', 403)
  const token = mpToken(env)
  if (!token) return error('Pagamento online ainda não está configurado', 503)
  let body
  try { body = await readJson(request, 4_096) } catch { return error('JSON inválido') }
  const merchantId = Number(body?.merchantId)
  const email = cleanString(body?.email, 160).toLowerCase()
  if (!Number.isSafeInteger(merchantId) || merchantId < 1 || !email) return error('Dados inválidos', 422)

  const row = await env.DB.prepare(`
    SELECT m.id, m.business_name, m.email, s.amount_cents
    FROM merchants m JOIN subscriptions s ON s.merchant_id = m.id
    WHERE m.id = ?
  `).bind(merchantId).first()
  if (!row || String(row.email).toLowerCase() !== email) return error('Cadastro não encontrado', 404)

  const preference = {
    items: [{
      id: `assinatura-${row.id}`,
      title: 'Assinatura MicroFoodBR (30 dias)',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Number(row.amount_cents) / 100,
    }],
    payer: { email: row.email },
    external_reference: String(row.id),
    notification_url: `${url.origin}/api/mp/webhook`,
    back_urls: { success: url.origin, pending: url.origin, failure: url.origin },
    statement_descriptor: 'MICROFOODBR',
  }
  const response = await fetch(`${MP_API}/checkout/preferences`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(preference),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.init_point) {
    console.error('Mercado Pago recusou a criação do checkout:', response.status, JSON.stringify(data).slice(0, 500))
    return error('Não foi possível iniciar o pagamento agora', 502)
  }
  return json({ url: data.init_point })
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function mpWebhook(request, env, url) {
  const secret = env.MP_WEBHOOK_SECRET
  const token = mpToken(env)
  if (!secret || !token) return error('Webhook não configurado', 503)
  if (!await validMpSignature(request, url, secret)) return error('Assinatura inválida', 401)

  let body = {}
  try { body = await readJson(request, 16_384) } catch { /* o id também vem na query */ }
  const type = url.searchParams.get('type') || url.searchParams.get('topic') || body?.type || body?.topic
  if (type !== 'payment') return json({ ok: true, ignored: type || 'sem tipo' })
  const paymentId = String(url.searchParams.get('data.id') || body?.data?.id || '').trim()
  if (!/^\d{1,20}$/.test(paymentId)) return error('Pagamento inválido', 422)

  const response = await fetch(`${MP_API}/v1/payments/${paymentId}`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) {
    console.error('Falha ao consultar pagamento no Mercado Pago:', paymentId, response.status)
    return error('Não foi possível consultar o pagamento', 502)
  }
  const payment = await response.json()
  if (payment.status !== 'approved') return json({ ok: true, status: payment.status })

  const merchantId = Number(payment.external_reference)
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) return json({ ok: true, ignored: 'sem referência de comerciante' })
  if (payment.currency_id !== 'BRL') return json({ ok: true, ignored: 'moeda diferente de BRL' })

  const subscription = await env.DB.prepare('SELECT amount_cents, paid_until FROM subscriptions WHERE merchant_id = ?').bind(merchantId).first()
  if (!subscription) return json({ ok: true, ignored: 'assinatura não encontrada' })
  const amountCents = Math.round(Number(payment.transaction_amount) * 100)
  if (!Number.isSafeInteger(amountCents) || amountCents < Number(subscription.amount_cents)) {
    console.error('Valor pago menor que a assinatura:', paymentId, amountCents, subscription.amount_cents)
    return json({ ok: true, ignored: 'valor menor que o da assinatura' })
  }

  const already = await env.DB.prepare('SELECT 1 AS found FROM payment_events WHERE external_id = ?').bind(paymentId).first()
  if (already) return json({ ok: true, duplicate: true })

  const today = new Date().toISOString().slice(0, 10)
  const base = subscription.paid_until && subscription.paid_until > today ? subscription.paid_until : today
  const paidUntil = addDays(base, SUBSCRIPTION_DAYS)
  const payload = JSON.stringify({ method: 'mercado_pago', payment_id: paymentId, payment_type: payment.payment_type_id, paid_until: paidUntil })
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payment_events (merchant_id, provider, external_id, status, amount_cents, payload) VALUES (?, 'mercado_pago', ?, 'paid', ?, ?)`).bind(merchantId, paymentId, amountCents, payload),
      env.DB.prepare(`UPDATE subscriptions SET status = 'active', paid_until = ?, mercado_pago_payment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE merchant_id = ?`).bind(paidUntil, paymentId, merchantId),
      env.DB.prepare(`UPDATE merchants SET plan = 'monthly', status = 'active', next_billing_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(paidUntil, merchantId),
    ])
  } catch (err) {
    if (String(err).toLowerCase().includes('unique')) return json({ ok: true, duplicate: true })
    console.error('Falha ao registrar pagamento do Mercado Pago:', err)
    return error('Não foi possível registrar o pagamento', 500)
  }
  return json({ ok: true, merchantId, paidUntil })
}

// ===== Guardiã do Repositório =====
const AI_API = 'https://api.openai.com/v1/chat/completions'
const AI_MODEL = 'gpt-4o-mini'
const AI_MAX_CHARS = 12_000

function aiTruncate(value) {
  return typeof value === 'string' ? value.slice(0, AI_MAX_CHARS) : ''
}

async function aiReview(request, env) {
  if (!sameOrigin(request)) return error('Origem não autorizada', 403)
  if (!env.OPENAI_API_KEY) return error('A Guardiã ainda não está configurada', 503)

  let body
  try { body = await readJson(request, 65_536) } catch {
    return error('JSON inválido ou muito grande', 413)
  }

  const filePath = cleanString(body?.path, 300)
  const situation = cleanString(body?.situation, 30)
  const newContent = aiTruncate(body?.newContent)
  const oldContent = aiTruncate(body?.oldContent)

  if (!filePath) return error('Informe o caminho do arquivo', 422)
  if (!['novo', 'conflito', 'duplicado'].includes(situation)) {
    return error('Situação inválida. Use: novo, conflito ou duplicado', 422)
  }
  if (!newContent) return error('Informe o conteúdo do arquivo novo', 422)

  const system = [
    'Você é a Guardiã do Repositório MicroFoodBR.',
    'Analise arquivos candidatos à integração e responda SOMENTE com JSON válido.',
    'Formato: {"decisao":"entrar|atualizar|substituir|manter_antigo|acao_manual","confianca":"alta|media|baixa","motivo":"texto curto","riscos":["texto"],"passos":["texto"]}.',
    'Regras: arquivos SQL, variáveis de ambiente, credenciais, chaves e configurações sensíveis devem receber decisao "acao_manual".',
    'Não invente conteúdo. Se faltar informação, use confianca "baixa".',
  ].join(' ')

  const user = [
    `Arquivo: ${filePath}`,
    `Situação: ${situation}`,
    'Conteúdo novo:',
    newContent,
    oldContent ? 'Conteúdo atual no repositório:' : 'Não há conteúdo anterior informado.',
    oldContent,
  ].join('\n')

  const response = await fetch(AI_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error('OpenAI recusou a análise:', response.status, JSON.stringify(data).slice(0, 500))
    return error('A Guardiã não conseguiu analisar agora', 502)
  }

  let analysis
  try {
    analysis = JSON.parse(data.choices?.[0]?.message?.content || '{}')
  } catch {
    return error('Resposta inválida da IA', 502)
  }

  const decisions = new Set(['entrar', 'atualizar', 'substituir', 'manter_antigo', 'acao_manual'])
  if (!decisions.has(analysis.decisao)) {
    return error('A IA retornou uma decisão inválida', 502)
  }

  return json({
    ok: true,
    path: filePath,
    situation,
    decision: analysis.decisao,
    confidence: analysis.confianca || 'baixa',
    reason: cleanString(analysis.motivo, 500),
    risks: Array.isArray(analysis.riscos) ? analysis.riscos.slice(0, 10).map((item) => cleanString(item, 300)) : [],
    steps: Array.isArray(analysis.passos) ? analysis.passos.slice(0, 10).map((item) => cleanString(item, 300)) : [],
  })
}

async function serveAsset(request, env, url, path) {
  if (!env.ASSETS) return new Response('Asset binding ASSETS não configurado', { status: 500 })
  let assetRequest = request
  const isAdminPage = path === '/admin' || path === '/admin.html'
  if (path === '/admin' && request.method === 'GET') {
    assetRequest = new Request(new URL('/admin.html', url), request)
  }
  const response = await env.ASSETS.fetch(assetRequest)
  if (!isAdminPage) return response
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-store')
  headers.set('x-frame-options', 'DENY')
  headers.set('referrer-policy', 'same-origin')
  headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none';")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, '') || '/'

    try {
      if (path === '/api/admin/login' && request.method === 'POST') return await adminLogin(request, env)
      if (path === '/api/admin/logout' && request.method === 'POST') return adminLogout()
      if (path === '/api/admin/session' && request.method === 'GET') {
        return await isAdmin(request, env) ? json({ ok: true }) : error('Não autorizado', 401)
      }
      if (path.startsWith('/api/admin/')) {
        if (!await isAdmin(request, env)) return error('Não autorizado', 401)
        if (path === '/api/admin/summary' && request.method === 'GET') return await adminSummary(env)
        if (path === '/api/admin/merchants' && request.method === 'GET') return await listMerchants(request, env)
        if (path === '/api/admin/orders' && request.method === 'GET') return await adminOrders(url, env)
        const paymentMatch = path.match(/^\/api\/admin\/merchants\/(\d+)\/payments$/)
        if (paymentMatch && request.method === 'POST') return await recordManualPayment(request, env, Number(paymentMatch[1]))
        const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/)
        if (orderMatch && request.method === 'PATCH') return await updateOrder(request, env, Number(orderMatch[1]))
        return error('Rota administrativa não encontrada', 404)
      }
      if (path === '/api/health' && request.method === 'GET') {
        await env.DB.prepare('SELECT 1').first()
        return json({ ok: true })
      }
      if (path === '/api/menu' && request.method === 'GET') return await getMenu(url, env)
      if (path === '/api/merchants' && request.method === 'POST') return await createMerchant(request, env)
      if (path === '/api/merchants' && request.method === 'GET') return await listMerchants(request, env)
      if (path === '/api/orders' && request.method === 'POST') return await createOrder(request, env)
      if (path === '/api/checkout' && request.method === 'POST') return await createCheckout(request, env, url)
      if (path === '/api/mp/webhook' && request.method === 'POST') return await mpWebhook(request, env, url)
      if (path === '/api/orders' && request.method === 'GET') return await listOrders(request, env)
      if (path === '/api/ai/review' && request.method === 'POST') return await aiReview(request, env)
      if (path.startsWith('/api/')) return error('Rota não encontrada', 404)
      return await serveAsset(request, env, url, path)
    } catch (err) {
      console.error('Erro não tratado no Worker:', err)
      return error('Erro interno do servidor', 500)
    }
  },
}
