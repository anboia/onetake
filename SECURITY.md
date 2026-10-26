# Segurança e privacidade

OneTake controla um dispositivo físico e pode capturar conteúdo pessoal. Use apenas aparelhos, apps e contas para os quais você tem autorização. Revise roteiros e alterações de código antes de executá-los.

## Reportar uma vulnerabilidade

**Não abra uma issue pública com detalhes exploráveis, dados pessoais ou segredos.** Se o repositório oferecer **Security → Report a vulnerability**, use esse canal privado do GitHub. Sua disponibilidade depende de o mantenedor ativá-lo.

Enquanto esse canal não estiver disponível, peça ao mantenedor, por uma issue sem detalhes técnicos sensíveis, que disponibilize um meio privado de contato. Não publique a reprodução até obter esse canal. Não há um endereço de segurança inventado nem SLA de resposta garantido.

Inclua em privado: versão/commit, componente afetado, impacto, reprodução mínima com dados sintéticos e mitigação sugerida. Nunca inclua senha, token real, certificado, perfil de provisionamento, vídeo pessoal ou dump do dispositivo.

## Escopo e suporte

Projeto experimental. Correções serão avaliadas sobre o desenvolvimento atual; não há linhas de versões antigas com suporte garantido. Não há auditoria independente ou certificação de segurança implícita.

## Limites de segurança

- O runner usa token efêmero e controle de acesso por sessão. Não exponha suas portas na rede.
- Não habilite modos experimentais de binding ou APIs privadas sem analisar os riscos.
- Apps e URLs devem estar na allowlist; não remova proteções para contornar uma falha de teste.
- Login, Face ID, senhas e códigos de verificação são tarefas humanas.
- `tap` não sabe se o botão compra, apaga ou envia algo. Um toque pode ter efeito irreversível; a anotação MCP não substitui autorização.
- `take run --dry` continua fazendo ações reais; somente `take validate` é validação offline.
- A senha do OBS fica no Chaveiro, não no JSON, ambiente compartilhado, argumentos de processo ou repositório. O serviço legado do Chaveiro é `contrarregra`.
- O obs-websocket pode escutar em interfaces de rede além de loopback. Use autenticação forte, firewall/rede confiável e desligue-o fora das sessões.
- Mantenha áudio do Mac fora da trilha gravada e desative notificações por conta própria antes de gravar.

## Antes de compartilhar arquivos

Revise capturas, vídeo, transcrições, logs e `take.json`. Remova identificadores de dispositivos, nomes pessoais, URLs privadas, dados de usuários e conteúdo do app. `.gitignore` não protege arquivos já rastreados nem o histórico.

Um segredo que chegou ao Git precisa ser **revogado/rotacionado**. Apagar o arquivo ou torná-lo privado não invalida o segredo. Reescrever histórico exige coordenação e autorização do titular. Consulte o [checklist de publicação](docs/publishing.md).
