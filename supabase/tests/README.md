# Testes locais de Gemini e Supabase

Não usam MCP, banco de produção ou chamadas reais Gemini.

```sh
deno test --allow-read --allow-env supabase/tests/gemini_functions_test.ts
deno check supabase/functions/analysis-batch-submit/index.ts supabase/functions/analysis-batch-poll/index.ts supabase/functions/analisar-conversa-unica/index.ts supabase/functions/processar-midia-pendente/index.ts supabase/functions/sync-clint/index.ts
npm install --prefix /tmp/3jotas-sql-tests @electric-sql/pglite@0.3.14 --ignore-scripts --no-audit --no-fund
node supabase/tests/gemini_execucoes_sql.mjs
```

PGlite executa PostgreSQL em um banco descartável com fixtures das tabelas/roles necessárias. O teste aplica a migration real e o relatório SQL. Para outra instalação, configure PGLITE_MODULE com o caminho absoluto do módulo `dist/index.js`. Não é uma validação do runtime Edge/pg_cron; essa confirmação exige publicação no Supabase e uma execução real.
