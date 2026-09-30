import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' })
    const { rows } = await pool.query('SELECT id, name, description, price_cents, image_url FROM menu_items WHERE available = TRUE ORDER BY id')
    return res.status(200).json(rows)
  } catch (error) {
    console.error('[v0] menu query failed', error)
    return res.status(500).json({ error: 'Não foi possível carregar o cardápio' })
  }
}

export const config = { api: { responseLimit: '1mb' } }

if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  const seed = async () => {
    const { rowCount } = await pool.query('SELECT 1 FROM menu_items LIMIT 1')
    if (!rowCount) await pool.query("INSERT INTO menu_items (name, description, price_cents, image_url) VALUES ('Bowl Mediterrâneo', 'Grãos, vegetais assados, folhas e molho cítrico.', 2890, '/food-bowl.png'), ('Bowl Verde', 'Folhas, abacate, grão-de-bico e sementes tostadas.', 2590, '/food-bowl.png'), ('Bowl Proteico', 'Arroz integral, legumes e proteína grelhada.', 3190, '/food-bowl.png')")
  }
  seed().catch((error) => console.error('[v0] menu seed failed', error))
}

export { pool }
