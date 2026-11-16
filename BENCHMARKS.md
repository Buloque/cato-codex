# Benchmarks e alegações

## Resultado atual

Nenhum benchmark comparativo com modelo foi executado neste ambiente. Uma tentativa de validação com `codex exec` falhou antes de iniciar subprocessos: projeto não confiável teve config/hook local desabilitada e o executor retornou `registered Core process has no package identity`. Portanto, este fork ainda não demonstra redução de tokens, custo ou tempo sem queda de qualidade.

O hook mede bytes de saída antes/depois da compressão para os casos suportados. Essa é uma redução observada de texto, não uma contagem de tokens economizados. A estatística do ledger mede uso real apenas quando o Codex entrega `PostModelRequest.token_usage`; consulte `cato stats` separadamente.

## Protocolo reproduzível para comparação

1. Fixe commit, versão Codex, modelo, prompt, limite de contexto, dependências e máquina.
2. Use pelo menos cinco tarefas pequenas com fixture imutável e testes ocultos congelados.
3. Execute cada tarefa com e sem CATO em ordem aleatória, no mínimo cinco repetições por condição.
4. Salve resultados brutos localmente: versão, ordem, tempo, requests, tokens oficiais por request, bytes lidos/retornados e resultado dos testes. Remova nomes/caminhos pessoais antes de compartilhar.
5. Compare medianas e dispersão; publique qualidade/testes junto com tokens/tempo. Separe contagens oficiais de aproximações por bytes ou caracteres.
6. Não anuncie economia se a variação se sobrepuser ou se a qualidade/testes regredir.

O pacote atual inclui testes determinísticos locais para ledger, hooks, MCP e instalação, além do empacotamento executável no CI. Eles verificam corretude de software, não eficácia frente a um modelo.
