export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const merchantId = Number(url.searchParams.get('merchant_id') ?? url.searchParams.get('merchantId'))
  const category = url.searchParams.get('category')?.trim() || ''
  const search = url.searchParams.get('search')?.trim() || ''
  const availableParam = url.searchParams.get('available')
  const available = availableParam === null ? true : ['true', '1', 'yes', 'on'].includes((availableParam ?? '').toLowerCase())
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 50)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)

  const conditions = ['1 = 1']
  const params = []

  if (Number.isFinite(merchantId) && merchantId > 0) {
    conditions.push('merchant_id = ?')
    params.push(merchantId)
  }

  if (availableParam !== null) {
    conditions.push('available = ?')
    params.push(available ? 1 : 0)
  }

  if (category) {
    conditions.push('category = ?')
    params.push(category)
  }

  if (search) {
    conditions.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)')
    params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`)
  }

  const countSql = `SELECT COUNT(*) AS total FROM menu_items WHERE ${conditions.join(' AND ')}`
  const totalResult = await env.DB.prepare(countSql).bind(...params).first()

  const sql = `
    SELECT id, merchant_id, name, description, category, price_cents, image_url, available
    FROM menu_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY available DESC, id DESC
    LIMIT ? OFFSET ?
  `

  const items = await env.DB.prepare(sql).bind(...params, limit, offset).all()

  return Response.json({
    items: items.results,
    total: Number(totalResult?.total || 0),
    limit,
    offset,
  })
}
