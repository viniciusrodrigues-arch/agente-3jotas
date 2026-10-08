// Testes carregam cópias em memória com mocks; os index.ts entregues não exportam helpers.
const raiz = new URL('../functions/', import.meta.url);
let handler: (req: Request) => Promise<Response>;
(globalThis as any).__capturar = (fn: typeof handler) => { handler = fn; };
(globalThis as any).__client = null;
async function carregar(nome: string, exports: string[]) {
  const fonte = (await Deno.readTextFile(new URL(`${nome}/index.ts`, raiz)))
    .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => (globalThis as any).__client;')
    .replace('Deno.serve(', '(globalThis as any).__capturar(')
    + `\nexport { ${exports.join(',')} };`;
  return await import(`data:application/typescript;base64,${btoa(unescape(encodeURIComponent(fonte)))}`);
}
function igual(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const submit = await carregar('analysis-batch-submit', ['limitesDia','janelaNoturna','hashInput','criarSnapshot','buscarMensagensDoGrupo','extrairJSONResposta']);
const media = await carregar('processar-midia-pendente', ['resolverMime','extrairTexto','encodeBase64']);
Deno.test('fronteiras do dia e janela noturna em Fortaleza', () => {
  igual(submit.limitesDia('2026-10-07'), { inicio: '2026-10-07T03:00:00.000Z', fim: '2026-10-08T03:00:00.000Z' });
  igual(submit.janelaNoturna(new Date('2026-10-08T03:00:00Z')), true);
  igual(submit.janelaNoturna(new Date('2026-10-08T06:59:59Z')), true);
  igual(submit.janelaNoturna(new Date('2026-10-08T07:00:00Z')), false);
});
Deno.test('dia alvo e paginação preservam ontem mesmo com mensagens de hoje', async () => {
  const msgs = Array.from({ length: 1001 }, (_,i) => ({ id: `${i}`, conversa_id: 'a', remetente: 'corretor', autor_crm_user_id: 'humano', texto: 'oi', enviada_em:'2026-10-07T15:00:00Z' }));
  msgs.push({ ...msgs[0], id:'hoje', enviada_em:'2026-10-08T15:00:00Z' });
  const cliente = { rpc() { return Promise.resolve({ data: [{id:'a',humano_assumiu_em:null,canonica_id:'a'}], error: null }); }, from(table: string) {
    let start=0,end=499,lower='',upper='';
    const builder: any = {
      select(){return this;}, in(){return this;}, order(){return this;}, or(){return this;},
      range(a:number,b:number){start=a;end=b;return this;},gte(_k:string,v:string){lower=v;return this;},lt(_k:string,v:string){upper=v;return this;},
      then(resolve:any){ const data = table==='conversas' ? [{id:'a',humano_assumiu_em:null}] : msgs.filter(m=>m.enviada_em>=lower&&m.enviada_em<upper).slice(start,end+1); return Promise.resolve({data,error:null}).then(resolve); },
    };return builder;
  }};
  const r=await submit.buscarMensagensDoGrupo(cliente,{id:'a',substituida_por_id:null},'2026-10-07');
  igual(r.dia,'2026-10-07');igual(r.mensagens.length,1001);igual(r.mensagens.some((m:any)=>m.id==='hoje'),false);
});
Deno.test('hash estável e sensível a prompt, conteúdo e modelo de revisão', async () => {
  igual(await submit.hashInput({a:1,b:2}), await submit.hashInput({b:2,a:1}));
  const a=await submit.hashInput({modeloRevisao:'3.6',texto:'não quero'});
  igual(a===await submit.hashInput({modeloRevisao:'3.6',texto:'quero'}),false);
  igual(a===await submit.hashInput({modeloRevisao:'2.5',texto:'não quero'}),false);
});
Deno.test('JSON multipart ignora pensamento e rejeita truncamento e nota fora do limite', () => {
  const p=[{criterio:'fluxo',ativo:true,nota_maxima:3}];
  const result={fluxo:{score:2,evidencia:'oi',justificativa:'ok'},justificativa_geral:'ok'};
  const data={candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'ignorar'},{text:JSON.stringify(result).slice(0,20)},{text:JSON.stringify(result).slice(20)}]}}]};
  igual(submit.extrairJSONResposta(data,p,'analise'),result);
  for(const d of [{candidates:[{finishReason:'MAX_TOKENS'}]},{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...result,fluxo:{...result.fluxo,score:4}})}]}}]}]) {
    let erro=false;try{submit.extrairJSONResposta(d,p,'analise');}catch{erro=true;}igual(erro,true);
  }
});
Deno.test('áudio: assinatura MIME, resposta multipart e base64 em blocos', () => {
  igual(media.resolverMime('audio/ogg','application/octet-stream',new TextEncoder().encode('RIFF1234WAVE').buffer),'audio/wav');
  igual(media.extrairTexto({candidates:[{finishReason:'STOP',content:{parts:[{text:'primeiro '},{text:'segundo'}]}}]}),'primeiro segundo');
  const bytes=new Uint8Array(50000).fill(255);igual(media.encodeBase64(bytes.buffer),btoa(String.fromCharCode(...bytes)));
});

const poll = await carregar('analysis-batch-poll', ['registrarFalhaPoll','enviarLote']);
Deno.test('404 faz backoff e entra em quarentena na terceira falha; 401 é imediato', async () => {
  const updates:any[]=[]; const rpcs:any[]=[];
  const cliente={from(){return {update(data:any){updates.push(data);return this;},eq(){return Promise.resolve({data:null,error:null});}};},rpc(nome:string,args:any){rpcs.push({nome,args});return Promise.resolve({data:null,error:null});}};
  await poll.registrarFalhaPoll(cliente,[{id:'a',poll_tentativas:0}],404);
  igual(updates[0].poll_tentativas,1);igual(rpcs.length,0);
  await poll.registrarFalhaPoll(cliente,[{id:'a',poll_tentativas:2}],404);
  igual(rpcs[0].nome,'gemini_falhar');igual(rpcs[0].args.p_incerta,true);
  await poll.registrarFalhaPoll(cliente,[{id:'b',poll_tentativas:0}],401);
  igual(rpcs.length,2);igual(rpcs[1].args.p_incerta,true);
});
Deno.test('envio Batch usa ID de execução e registra envio incerto sem repetir', async () => {
  const chamadas:any[]=[];let payload:any;
  const cliente={rpc(nome:string,args:any){chamadas.push({nome,args});return Promise.resolve({data:1,error:null});}};
  const original=globalThis.fetch;
  globalThis.fetch=async (_url:any,opts:any)=>{payload=JSON.parse(opts.body);throw new Error('timeout simulado');};
  try{
    await poll.enviarLote(cliente,'chave-teste',[{id:'exec-1',modelo:'modelo-congelado',etapa:'revisao'}],[{contents:[]}]);
    igual(payload.batch.input_config.requests.requests[0].metadata.key,'exec-1');
    igual(chamadas[0].nome,'gemini_marcar_envio');igual(chamadas[1].args.p_incerta,true);igual(chamadas.length,2);
  }finally{globalThis.fetch=original;}
});
