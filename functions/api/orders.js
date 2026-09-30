function bad(message, status = 400) {
  return Response.json({ error: message }, { status })
}

export async function onRequestPost({ request, env }) {
  let body
  try { body = await request.json() } catch { return bad('JSON inválido') }
  if (!Number.isInteger(body.merchantId) || !body.customerName?.trim() || !body.customerPhone?.trim() || !Array.isArray(body.items) || body.items.length === 0) {
    return bad('Informe comerciante, cliente, telefone e itens')
  }

  const ids = body.items.map((item) => Number(item.menuItemId)).filter(Number.isInteger)
  if (ids.length !== body.items.length) return bad('Itens inválidos')
  const placeholders = ids.map(() => '?').join(',')
  const { results } = await env.DB.prepare(`SELECT id, merchant_id, name, price_cents FROM menu_items WHERE merchant_id = ? AND available = 1 AND id IN (${placeholders})`).bind(body.merchantId, ...ids).all()
  const catalog = new Map(results.map((item) => [item.id, item]))
  let total = 0
  const lines = []
  for (const input of body.items) {
    const item = catalog.get(Number(input.menuItemId))
    const quantity = Number(input.quantity)
    if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return bad('Produto ou quantidade inválida')
    const subtotal = item.price_cents * quantity
    total += subtotal
    lines.push({ item, quantity, subtotal })
  }
  if (total <= 0) return bad('Pedido inválido')

  const order = await env.DB.prepare(`INSERT INTO orders (merchant_id, customer_name, customer_phone, delivery_address, notes, total_cents) VALUES (?, ?, ?, ?, ?, ?)`).bind(body.merchantId, body.customerName.trim(), body.customerPhone.trim(), body.deliveryAddress?.trim() || null, body.notes?.trim() || null, total).run()
  for (const line of lines) {
    await env.DB.prepare(`INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_cents, quantity, subtotal_cents) VALUES (?, ?, ?, ?, ?, ?)`).bind(order.meta.last_row_id, line.item.id, line.item.name, line.item.price_cents, line.quantity, line.subtotal).run()
  }
  return Response.json({ id: order.meta.last_row_id, totalCents: total, status: 'pending' }, { status: 201 })
}

export async function onRequestGet({ request, env }) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return bad('Não autorizado', 401)
  const { results } = await env.DB.prepare(`SELECT o.id, o.customer_name, o.customer_phone, o.total_cents, o.status, o.created_at, m.business_name FROM orders o JOIN merchants m ON m.id = o.merchant_id ORDER BY o.created_at DESC LIMIT 100`).all()
  return Response.json({ orders: results })
}
