# Barbearia SaaS — Backend

API de agendamento online para várias barbearias (1 barbearia = 1 barbeiro = 1 plano mensal).
Node.js + Express 5 + MongoDB. Avisos por WhatsApp (API oficial da Meta) e cobrança por Pix.

---

## 1. Estrutura

```
barbearia-saas-backend/
├── .env.example              ← modelo das configurações (copie para .env)
├── package.json              ← dependências e comandos
├── requisicoes.http          ← testes prontos para a extensão REST Client do VS Code
├── scripts/
│   ├── gerarChaves.js        ← gera JWT_SECRET e ENCRYPTION_KEY
│   ├── criarAdmin.js         ← cria o SEU login de administrador
│   └── testarFluxo.js        ← teste completo no seu banco (apaga tudo no final)
└── src/
    ├── server.js             ← ponto de entrada (conecta banco, liga tarefas, sobe API)
    ├── app.js                ← monta o Express e as rotas
    ├── config/
    │   ├── env.js            ← lê o .env
    │   └── db.js             ← conexão MongoDB (pool ajustado + índices)
    ├── models/               ← Barbearia, Usuario, Servico, Cliente, Agendamento, Slot
    ├── middlewares/          ← login (JWT), licença, validação, limites, erros
    ├── services/
    │   ├── disponibilidade.js  ← horários livres + libera reservas não pagas
    │   ├── agendamentos.js     ← criar, confirmar Pix, cancelar, bloquear agenda
    │   ├── licenca.js          ← mês grátis, bloqueio automático, renovação
    │   ├── pix.js              ← escolhe Pix manual ou Mercado Pago
    │   ├── mercadoPago.js      ← Pix automático com confirmação por webhook
    │   ├── whatsapp.js         ← envio pela WhatsApp Cloud API
    │   └── notificacoes.js     ← todas as mensagens do sistema
    ├── routes/
    │   ├── auth.routes.js      ← /auth     cadastro, login, trocar senha
    │   ├── painel.routes.js    ← /painel   área do barbeiro
    │   ├── publico.routes.js   ← /publico  página onde o cliente agenda
    │   ├── admin.routes.js     ← /admin    SUA área (renovar/bloquear planos)
    │   └── webhooks.routes.js  ← /webhooks aviso de Pix pago (Mercado Pago)
    ├── jobs/tarefas.js       ← expirar reservas, lembretes, avisos de plano
    └── utils/                ← cache, criptografia, Pix copia e cola, datas
```

---

## 2. Onde alterar cada coisa

| O que | Onde |
|---|---|
| **String de conexão do MongoDB** | `.env` → `MONGODB_URI` |
| Segredos (login e criptografia) | `.env` → `JWT_SECRET` e `ENCRYPTION_KEY` (gere com `npm run gerar-chaves`) |
| Endereço do site e da API | `.env` → `FRONTEND_URL` e `API_URL` |
| Dias grátis e dias por renovação | `.env` → `DIAS_TESTE` e `DIAS_PLANO` |
| Seu WhatsApp de suporte | `.env` → `SUPORTE_WHATSAPP` |
| WhatsApp Cloud API | `.env` → `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` |
| Chave Pix / Mercado Pago de cada barbearia | Pelo painel: `PUT /painel/pagamento` (cada barbeiro configura a sua) |
| Regras de cada barbearia (sinal, prazo do Pix, cancelamento…) | Pelo painel: `PUT /painel/barbearia` |
| Texto das mensagens | No Gerenciador do WhatsApp da Meta (seção 6) |

Nada de senha ou token fica no código. O `.env` não vai para o GitHub.

---

## 3. Rodar no seu computador (Windows / PowerShell)

Pasta: `C:\Projetos\barbearia-saas\backend` (fora do OneDrive). O guia completo (frontend, publicação, custos) está no README da pasta principal.

```powershell
cd C:\Projetos\barbearia-saas\backend
npm install
copy .env.example .env
npm run gerar-chaves          # copie as 2 linhas para o .env
notepad .env                  # cole a MONGODB_URI e as chaves
npm run testar                # teste completo no banco (apaga os dados de teste)
npm run criar-admin -- seu@email.com SuaSenhaForte123 "Michael"
npm run dev                   # API em http://localhost:3000 (reinicia ao salvar)
```

Abra `requisicoes.http` no VS Code (extensão **REST Client**) e teste rota por rota.

### MongoDB Atlas (grátis)
1. cloud.mongodb.com → crie um cluster **M0 (Free)**.
2. **Database Access** → crie usuário e senha.
3. **Network Access** → `0.0.0.0/0` (necessário para o Render).
4. **Connect → Drivers** → copie a URI e cole em `MONGODB_URI`, trocando `<usuario>`, `<senha>` e colocando `/barbearia_saas` antes do `?`.

---

## 4. Como funciona

**Bloqueio de horário:** a agenda é dividida em blocos de 15 min. Um corte de 45 min ocupa 3 blocos na coleção `slots`, que tem índice único `(barbeariaId, inicio)`. Se dois clientes clicarem no mesmo horário ao mesmo tempo, o próprio banco recusa o segundo (HTTP 409).

**Pix:**
- `manual` (padrão): o sistema gera o **Pix copia e cola já com o valor** a partir da chave do barbeiro. O barbeiro recebe aviso no WhatsApp e confirma no painel com 1 toque.
- `mercadopago`: cada barbearia cola o próprio Access Token. O Pix é gerado pelo Mercado Pago e **confirmado sozinho** pelo webhook. O dinheiro cai direto na conta do barbeiro.
- Reserva não paga no prazo (`minutosParaPagar`) expira e o horário volta a ficar livre.
- Se o Pix for pago depois de expirar: o sistema tenta recuperar o horário; se já foi ocupado, marca `conflito` e avisa o barbeiro para devolver o valor.

**Licença (seu controle):**
- Cadastro → `acessoAte = hoje + 30 dias` (plano `teste`).
- Toda requisição compara `acessoAte` com agora. Venceu = bloqueado na hora, sem depender de tarefa nenhuma.
- Vencido: painel responde **402** (o app mostra "renove seu plano" + seu WhatsApp); página pública responde **403** "agenda indisponível". Agendamentos já confirmados continuam valendo e nenhum dado é apagado.
- O barbeiro recebe aviso 3 dias antes, 1 dia antes e no dia do vencimento.
- Você renova com `POST /admin/barbearias/:id/renovar` (+30 dias, somando aos dias que ainda faltavam).

**Melhorias de desempenho trazidas do Glamour:** pool de conexões ajustado, índices em todos os filtros, listas paginadas, resumo do painel em uma única aggregation, cache stale-while-revalidate só para dados que mudam pouco (horários livres nunca vão para cache), compressão das respostas e rota `/health` para o ping que evita o cold start do Render.

---

## 5. Rotas

| Método | Rota | Quem |
|---|---|---|
| POST | `/auth/cadastro` · `/auth/login` · `/auth/trocar-senha` | todos |
| GET | `/publico/:slug` | cliente |
| GET | `/publico/:slug/disponibilidade?servicoId=&data=AAAA-MM-DD` | cliente |
| POST | `/publico/:slug/agendamentos` | cliente |
| GET | `/publico/agendamentos/:id?c=codigo` (tela do Pix consulta se já pagou) | cliente |
| POST | `/publico/agendamentos/:id/cancelar` | cliente |
| GET | `/painel/licenca` (funciona mesmo vencido) | barbeiro |
| GET/PUT | `/painel/me` · `/painel/barbearia` · `/painel/pagamento` | barbeiro |
| GET/POST/PUT/DELETE | `/painel/servicos` | barbeiro |
| GET | `/painel/agendamentos?data=` · `/painel/resumo` · `/painel/clientes` | barbeiro |
| POST | `/painel/agendamentos/:id/confirmar` · `/cancelar` | barbeiro |
| POST/DELETE | `/painel/bloqueios` | barbeiro |
| GET | `/admin/barbearias` · `/admin/resumo` · `/admin/barbearias/:id` | você |
| POST | `/admin/barbearias/:id/renovar` · `/bloquear` · `/resetar-senha` | você |
| POST | `/webhooks/mercadopago/:barbeariaId` | Mercado Pago |

---

## 6. WhatsApp Cloud API (Meta)

Sem token no `.env`, as mensagens só aparecem no terminal. Para ligar de verdade:

1. business.facebook.com → crie/verifique o **Meta Business** (CNPJ ou MEI).
2. developers.facebook.com → **Criar app** → tipo **Empresa** → adicione **WhatsApp**.
3. Adicione um número que **não** esteja em uso no app WhatsApp.
4. Copie o **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
5. Gere um **token permanente**: Configurações do negócio → Usuários do sistema → Gerar token com `whatsapp_business_messaging` e `whatsapp_business_management` → `WHATSAPP_TOKEN`.
6. Gerenciador do WhatsApp → **Modelos de mensagem** → crie os 7 abaixo, categoria **Utilidade**, idioma **Português (BR)**, com estes nomes exatos:

| Nome | Texto |
|---|---|
| `reserva_pix_cliente` | Olá, {{1}}! Seu horário na {{2}} para {{3}} em {{4}} está reservado. Para confirmar, pague R$ {{5}} via Pix em até {{6}} minutos. Pix copia e cola: {{7}} . Assim que o pagamento for confirmado, você recebe a confirmação por aqui. |
| `agendamento_confirmado_cliente` | Pronto, {{1}}! Seu agendamento na {{2}} está confirmado: {{3}} em {{4}}. Endereço: {{5}}. Se precisar cancelar, use este link: {{6}} . Até logo! |
| `aviso_agendamento_barbeiro` | Aviso da sua agenda: {{1}}. Cliente: {{2}} ({{3}}). Serviço: {{4}} em {{5}}. Valor do serviço: R$ {{6}}, valor no Pix: R$ {{7}}. Abra o painel para ver os detalhes. |
| `reserva_expirada_cliente` | Olá, {{1}}. Sua reserva na {{2}} para {{3}} foi liberada porque o Pix não foi pago no prazo. Para agendar de novo, acesse {{4}} e escolha um novo horário. |
| `agendamento_cancelado_cliente` | Olá, {{1}}. Seu agendamento na {{2}} ({{3}} em {{4}}) foi cancelado. Para remarcar, acesse {{5}} quando quiser. |
| `lembrete_agendamento_cliente` | Olá, {{1}}! Lembrete do seu horário na {{2}}: {{3}} em {{4}}. Endereço: {{5}}. Te esperamos! |
| `aviso_plano_barbeiro` | Olá, {{1}}! Seu plano do sistema de agendamentos {{2}} (vencimento: {{3}}). Para renovar, fale com o suporte pelo WhatsApp {{4}} e continue recebendo agendamentos. |

Custo atual no Brasil: cerca de R$ 0,035 por mensagem de utilidade.

---

## 7. Mercado Pago (opcional, por barbearia)

1. O barbeiro entra em mercadopago.com.br/developers → **Suas integrações** → **Criar aplicação**.
2. **Credenciais de produção** → copia o **Access Token** (`APP_USR-...`).
3. Ele cola no painel (`PUT /painel/pagamento` com `"modo": "mercadopago"`). O token é salvo criptografado.
4. O aviso de pagamento chega em `API_URL/webhooks/mercadopago/<id da barbearia>` — só funciona com a API publicada em **https** (não funciona em localhost).

---

## 8. Publicar no Render

1. Suba o projeto para um repositório no GitHub (o `.env` fica de fora).
2. render.com → **New → Web Service** → escolha o repositório.
3. Build: `npm install` · Start: `npm start`.
4. **Environment** → cadastre as mesmas variáveis do `.env` (com `NODE_ENV=production` e `API_URL` igual ao endereço do Render).
5. Plano grátis "dorme" após 15 min sem uso: crie um monitor em cron-job.org chamando `https://SUA-API.onrender.com/health` a cada 10 min (ou use o plano pago quando tiver barbearias pagantes). As tarefas automáticas só rodam com a API acordada.
