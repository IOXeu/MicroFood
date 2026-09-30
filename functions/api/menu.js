export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(`
    SELECT id, merchant_id, name, description, price_cents, image_url
    FROM menu_items
    WHERE available = 1
    ORDER BY id DESC
  `).all()

  return Response.json({ items: results })
}
