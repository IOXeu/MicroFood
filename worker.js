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
    return js
