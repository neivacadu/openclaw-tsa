# OpenClaw-TSA · Fork Tráfego SA

This is a private fork of [`openclaw/openclaw`](https://github.com/openclaw/openclaw) maintained by **Tráfego SA** to host the **ace-tsia-beta** laboratory.

## Identidade

- **Upstream:** `github.com/openclaw/openclaw`
- **Fork owner:** [@neivacadu](https://github.com/neivacadu) (Cadu Neiva, CEO Tráfego SA)
- **Branches:**
  - `main` — sync periódico com upstream (read-only mirror)
  - `ace-tsia` — branch ativa do laboratório (TSA-core integrations + absorbed patterns)

## O que é ace-tsia-beta

ace-tsia-beta é o agente único da fusão **OpenClaw + Hermes Agent + FOCOS Engine + TSA-core** rodando em produção experimental no servidor `tsa-llm` da Tráfego SA. Mais detalhes:

- Framework de update contínuo: `~/Documents/TSA-ACE/ace-tsia-beta-v1-update-framework.md` (Mac do Cadu)
- Arquitetura v2.3: `~/Documents/TSA-ACE/ace-tsia-arquitetura-v2.3.md`
- Estado v3.0 projetado: `~/Documents/TSA-ACE/ace-tsia-v3.0-estrutura-completa.html`

## Estratégia C · "Consume don't contribute"

O fork **não envia PRs upstream** ao OpenClaw nem ao Hermes. Patterns relevantes do Hermes Agent são **absorvidos como código TSA** dentro deste fork (não como dependências). Updates upstream do OpenClaw são consumidos via `git fetch upstream main` + merge na branch `ace-tsia` quando aplicável.

## TSA-core inalienável

A base TSA (Constitution 14 regras · 500 skills Gold Standard · 402 pipelines · 15 hooks segurança · Camada 7 Async Orchestration · Multi-tenancy R1-R8 · 25 decisões travadas) **nunca muda em update upstream**. Todo merge passa por gates G1-G5 antes de subir pro service.

## Service em produção

```
host:    tsa-llm (Tailscale 100.73.250.23)
service: ace-cadu-claw-telegram.service
user:    ace-tsia
bot:     @ace_tsia_bot (Telegram)
ExecStart: /usr/bin/node /opt/openclaw-tsa-git/openclaw.mjs gateway --port 18889
update:  /opt/aceupgrade/aceupgrade.sh openclaw <ref>
```

## Commit ZERO da fusão

Este arquivo é o **primeiro commit do branch `ace-tsia`** demonstrando que o ciclo de fork (modify → commit → push → rebuild → deploy) funciona end-to-end. A partir daqui, cada absorção de pattern Hermes ou modificação TSA-core gera novo commit auditável.
