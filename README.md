# Conty. Revisão de roteiro

API do fluxo de roteiro: o criador envia, a marca pede alteração com motivo e prazo, o criador reenvia, a marca aprova. Cada envio é uma versão, e nenhuma versão é sobrescrita.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev
```

A API sobe em `http://127.0.0.1:3003` e grava em `data/roteiros.sqlite` (`PORT` e `DB_PATH` mudam isso).

## Por onde ler

1. `src/script-review.ts`: os estados e as regras. É o arquivo que importa.
2. `src/deadline.ts`: o prazo no fuso da marca.
3. `test/script-review.test.ts`: o fluxo, as recusas e o prazo com relógio controlado.
4. `src/app.ts`: só HTTP.

## Estados

O roteiro tem um `status` gravado e a resposta traz `allowed_actions`, que diz o que marca e criador podem fazer agora.

| `status` | Significa | Marca pode | Criador pode |
|---|---|---|---|
| `in_review` | A versão atual espera a marca | pedir alteração, aprovar | nada |
| `changes_requested`, prazo valendo | A marca pediu alteração | nada | enviar nova versão |
| `changes_requested`, prazo vencido | O pedido não vale mais | pedir alteração de novo, com prazo novo | nada |
| `approved` | Encerrado | nada | nada |

Qualquer ação fora da tabela responde `409` com um `code` que diz o motivo.

## Prazo

O prazo é um dia (`AAAA-MM-DD`) em `America/Sao_Paulo`, e vale até o último instante desse dia. Com prazo `2026-03-12`:

- `2026-03-13T02:59:59.999Z` é 23:59:59.999 do dia 12 em São Paulo: ainda vale, mesmo com o dia UTC já virado.
- `2026-03-13T03:00:00.000Z` é 00:00 do dia 13: passou.

A mesma regra vale nos dois lugares em que o prazo aparece: a marca não consegue criar um pedido com prazo que já passou (`422 due_date_passed`), e o criador não consegue responder a um pedido vencido (`409 deadline_passed`). O relógio é injetado em `createApp(db, clock)`, e os testes usam esses dois instantes.

## API

Não há autenticação. O cabeçalho `x-role` (`brand` ou `creator`) separa quem pode o quê; papel errado responde `403`.

| Rota | Papel | Faz |
|---|---|---|
| `POST /scripts` | creator | cria o roteiro com a versão 1 |
| `GET /scripts/:id` | qualquer | roteiro, versões, pedidos e ações permitidas |
| `POST /scripts/:id/change-requests` | brand | pede alteração (`reason`, `due_date`) |
| `POST /scripts/:id/versions` | creator | envia nova versão |
| `POST /scripts/:id/approval` | brand | aprova a versão atual |

Erros têm sempre a forma `{ "error": { "code": "...", "message": "..." } }`: `422` para entrada inválida, `409` para ação que o estado não permite, `404` para roteiro inexistente.

### Exemplos

Criar:

```bash
curl -s -X POST localhost:3003/scripts \
  -H 'content-type: application/json' -H 'x-role: creator' \
  -d '{"title":"Verão beleza","content":"Abertura com o produto na mão."}'
```

```json
{
  "id": "scr_7b1e…",
  "title": "Verão beleza",
  "status": "in_review",
  "current_version": 1,
  "approved_version": null,
  "approved_at": null,
  "allowed_actions": { "brand": ["request_changes", "approve"], "creator": [] },
  "versions": [
    { "number": 1, "content": "Abertura com o produto na mão.", "submitted_at": "2026-03-10T15:00:00.000Z" }
  ],
  "change_requests": []
}
```

Pedir alteração sem motivo:

```bash
curl -s -X POST localhost:3003/scripts/scr_7b1e…/change-requests \
  -H 'content-type: application/json' -H 'x-role: brand' \
  -d '{"due_date":"2026-03-12"}'
```

```json
{ "error": { "code": "reason_required", "message": "pedido de alteração precisa de motivo" } }
```

Depois do pedido válido (`{"reason":"Citar o cupom VERAO10 no fim","due_date":"2026-03-12"}`), da nova versão e de `POST /scripts/scr_7b1e…/approval`:

```json
{
  "id": "scr_7b1e…",
  "title": "Verão beleza",
  "status": "approved",
  "current_version": 2,
  "approved_version": 2,
  "approved_at": "2026-03-10T15:00:00.000Z",
  "allowed_actions": { "brand": [], "creator": [] },
  "versions": [
    { "number": 1, "content": "Abertura com o produto na mão.", "submitted_at": "2026-03-10T15:00:00.000Z" },
    { "number": 2, "content": "Abertura com o produto na mão. Fecha com o cupom VERAO10.", "submitted_at": "2026-03-10T15:00:00.000Z" }
  ],
  "change_requests": [
    {
      "id": "chg_7b1e…",
      "version": 1,
      "reason": "Citar o cupom VERAO10 no fim",
      "due_date": "2026-03-12",
      "requested_at": "2026-03-10T15:00:00.000Z",
      "deadline_passed": false
    }
  ]
}
```

Tentar outra versão depois de aprovado:

```json
{ "error": { "code": "script_approved", "message": "roteiro aprovado não aceita nova versão nem pedido de alteração" } }
```

## Decisões que eu deixaria diferentes com mais tempo

- **Prazo vencido trava o roteiro até a marca agir.** Li "pedido com prazo que já passou não vale" nos dois sentidos: não se cria pedido vencido e não se responde a pedido vencido. O efeito é que, vencido o prazo, só a marca destrava, abrindo outro pedido. Com mais tempo eu confirmaria com o produto se o criador atrasado deveria poder enviar mesmo assim, com a versão marcada como fora do prazo.
- **A marca não aprova uma versão sobre a qual pediu alteração.** Para aceitar a versão como está, hoje ela teria que esperar a resposta. Faltou um "retirar o pedido".
- **O estado vencido é calculado na leitura, não gravado.** `status` continua `changes_requested` e quem diz que venceu é `deadline_passed` e `allowed_actions`. Evita um job para virar o estado, mas quem filtrar só por `status` não vê a diferença.
- **O fuso é constante.** `America/Sao_Paulo` está em `src/deadline.ts`; deveria ser dado da marca.
- **Sem idempotência no reenvio.** Um `POST /versions` repetido por retry de rede cai em `409 awaiting_brand_review` em vez de devolver a versão já criada.

## O que ficou de fora

Autenticação e dono do roteiro (qualquer `x-role: brand` age em qualquer roteiro), vínculo com campanha, listagem e paginação, cancelamento, notificações e concorrência entre processos (as transações protegem um processo só, que é o que o SQLite local oferece aqui).

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus), a partir do enunciado. As decisões de modelagem acima foram propostas pela IA.

Verificação automática, rodada pela IA e não por mim: `npm test` passa com 19 testes em 1 arquivo e `npx tsc --noEmit` não acusa erro. Entre os testes estão "segue de envio a aprovação mostrando o estado e as ações permitidas em cada passo" e "aceita pedido com prazo para hoje no último instante do dia em São Paulo".

O que eu revisei: os padrões de backend, as tipagens, os early returns, as constantes e se os testes realmente testam os cenários de falha.
