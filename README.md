# MicroFoodBR — Cloudflare Worker + D1

Este pacote publica a aplicação como **Cloudflare Worker**, servindo o site e o painel em `/admin`, e implementando a API em `worker.js`.

## Recursos Cloudflare configurados

- **Worker:** `microfoodbr`.
- **D1:** `microfoodbr`, ID `f510d7b7-1e0b-4615-b489-fd6fe7a36b24`, binding `DB`.
- O projeto Cloudflare Pages também chamado `microfoodbr` é um recurso separado. Este pacote publica no Worker com `wrangler deploy`, não com `wrangler pages deploy`.

As tabelas existentes `merchants`, `subscriptions`, `menu_items`, `orders` e `order_items` foram conferidas como compatíveis. **Não crie outra base e não reaplique `schema.sql`**. As tabelas adicionais de fotos e usuários não são usadas nem alteradas por este Worker.

## Painel administrativo

Acesse `https://<endereço-do-worker>/admin`. O painel permite:

- Ver comerciantes, situação das assinaturas, vencimento e último pagamento registrado.
- Registrar pagamentos **manualmente** após conferir o recebimento fora do sistema, com valor, validade, referência e observação.
- Consultar pedidos com nome, telefone, endereço, observações, itens e total.
- Atualizar o status dos pedidos.

O painel exige o segredo `ADMIN_TOKEN`. **O segredo configurado em Cloudflare Pages não é compartilhado com o Worker.** Configure-o especificamente no Worker `microfoodbr` com:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Use um segredo longo e exclusivo. Ele é digitado na tela de login, mas não fica armazenado no navegador; o Worker cria uma sessão assinada em cookie `HttpOnly`, `Secure` e `SameSite=Strict`, válida por 8 horas. Não coloque esse segredo no Git nem no `wrangler.jsonc`.

**Os pagamentos não são confirmados automaticamente.** O registro do painel cria um evento identificado como manual. A integração automática exige webhook/API oficial do Mercado Pago; os segredos MP atualmente configurados no Pages não são usados por este Worker. Não marque um pagamento como recebido antes de conferi-lo.

## Instalar e publicar

```bash
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

O Worker serve os assets de `public/`; `/api/*` é encaminhado ao Worker, evitando incluir `node_modules` como asset. A publicação cria/atualiza o Worker; ela não altera o projeto Pages homônimo.

## Endpoints

- `GET /api/health` — verifica acesso ao D1.
- `GET /api/menu?merchant_id=1` — itens disponíveis e filtros opcionais.
- `POST /api/merchants` — cadastro de comerciante e período de teste.
- `POST /api/orders` — cria pedido e calcula preços no servidor.
- `POST /api/admin/login` / `POST /api/admin/logout` — sessão do painel.
- `GET /api/admin/summary`, `/api/admin/merchants`, `/api/admin/orders` — dados administrativos protegidos.
- `POST /api/admin/merchants/:id/payments` — registro manual de pagamento, protegido.
- `PATCH /api/admin/orders/:id` — atualização do status do pedido, protegida.

Para produção, considere também habilitar proteção contra abuso/rate limiting nos formulários públicos.

## Publicação automatizada pelo GitHub

No serviço Cloudflare Worker `microfoodbr`, configure a raiz de compilação como `cloudflare-worker` e o comando de deploy como `npm run deploy`. Isso mantém o projeto Pages existente na raiz do repositório separado. Configure `ADMIN_TOKEN` nos secrets do **Worker** (não nos de Pages). O banco D1 `microfoodbr` já está vinculado no `wrangler.jsonc`; não aplique o schema ao banco remoto.
