# MicroFoodBR — Cloudflare Worker + D1

Este pacote publica a aplicação como **Cloudflare Worker**, servindo o site e o painel em `/admin`, e implementando a API em `worker.js`.

## Estrutura do repositório

```
.
├── index.html            # Site do projeto Cloudflare Pages (microfoodbr.pages.dev)
├── functions/api/        # API do Pages (menu, merchants, orders)
├── public/               # Site + painel /admin servidos pelo Worker
│   ├── index.html
│   └── admin.html
├── worker.js             # API completa do Worker (D1 + painel admin)
├── wrangler.jsonc        # Config do Worker (binding DB -> D1 microfoodbr)
└── schema.sql            # Schema do banco (já aplicado; não reaplicar)
```

Há **dois caminhos de publicação independentes**: o Pages usa `index.html` + `functions/` da raiz; o Worker usa `public/` + `worker.js`.

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

## Pagamentos automáticos (Mercado Pago)

O Worker cria um link de pagamento **por comerciante** e confirma o pagamento sozinho:

1. Após o cadastro, o botão "Assinar" chama `POST /api/checkout` (`merchantId` + e-mail do cadastro) e leva o cliente ao checkout do Mercado Pago.
2. O Mercado Pago avisa `POST /api/mp/webhook`. O Worker confere a assinatura (`MP_WEBHOOK_SECRET`), consulta o pagamento na API (`Access_Token`) e, se estiver **aprovado**, em BRL e com valor igual ou maior que a assinatura, ativa o comerciante por **30 dias** (renovações antecipadas somam à data futura).
3. Cada pagamento é registrado uma única vez em `payment_events`; reenvios do aviso são ignorados.

Segredos do **Worker** usados: `Access_Token` (ou `MP_ACCESS_TOKEN`) e `MP_WEBHOOK_SECRET`. `Client_ID`, `Client_Secret` e `Public_Key` não são usados.

No painel do Mercado Pago (Suas integrações → Webhooks), cadastre a URL `https://<endereço-do-worker>/api/mp/webhook` com o evento **Pagamentos**; a chave secreta exibida ali é o valor de `MP_WEBHOOK_SECRET`. Estornos e cancelamentos ainda não são tratados automaticamente. O registro manual no `/admin` continua disponível como alternativa.

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
- `POST /api/checkout` — cria o link de pagamento da assinatura no Mercado Pago.
- `POST /api/mp/webhook` — recebe o aviso de pagamento do Mercado Pago.
- `POST /api/admin/login` / `POST /api/admin/logout` — sessão do painel.
- `GET /api/admin/summary`, `/api/admin/merchants`, `/api/admin/orders` — dados administrativos protegidos.
- `POST /api/admin/merchants/:id/payments` — registro manual de pagamento, protegido.
- `PATCH /api/admin/orders/:id` — atualização do status do pedido, protegida.

Para produção, considere também habilitar proteção contra abuso/rate limiting nos formulários públicos.

## Publicação automatizada pelo GitHub

No serviço Cloudflare Worker `microfoodbr`, deixe a raiz de compilação na raiz do repositório (`/`) e use o comando de deploy `npm run deploy`. O projeto Pages homônimo continua separado e não é alterado. Configure `ADMIN_TOKEN` nos secrets do **Worker** (não nos de Pages). O banco D1 `microfoodbr` já está vinculado no `wrangler.jsonc`; não aplique o schema ao banco remoto.
