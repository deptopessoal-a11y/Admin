// Cloud Function do Painel Admin — avaliação automática (por IA) das
// respostas dissertativas das provas, pra apoiar o gestor. NÃO é nota:
// é uma leitura qualitativa (adequada/parcial/inadequada + comentário)
// que grava na mesma coleção "avaliacoes_abertas" que a correção manual
// já usa (tela Correção, Resultados e Relatório individual do Admin) —
// o RH continua podendo revisar/sobrescrever qualquer avaliação da IA
// normalmente, pelos mesmos botões de sempre.
//
// Deploy (a partir da raiz do repo Admin):
//   1. npm install -g firebase-tools   (se ainda não tiver)
//   2. firebase login
//   3. Upgrade do projeto pro plano Blaze (Console do Firebase > Uso e
//      faturamento) — obrigatório pra Cloud Functions chamarem uma API
//      externa como a da Anthropic.
//   4. Criar uma chave em https://console.anthropic.com (Settings > API Keys)
//   5. firebase functions:secrets:set ANTHROPIC_API_KEY
//      (cola a chave quando pedir)
//   6. cd functions && npm install
//   7. Na raiz do repo: firebase deploy --only functions

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ maxInstances: 10 });

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODELO = 'claude-sonnet-5-5';
const AVALIADO_POR_IA = 'IA (Claude)';
const MAX_ITENS_POR_CHAMADA = 50;

const PROMPT_SISTEMA = `Você é um analista de RH avaliando, de forma qualitativa, a resposta de um
colaborador a uma pergunta dissertativa de uma avaliação interna de
conhecimento (parte de um programa de capacitação). Isso NÃO é uma nota —
é uma leitura de gestão sobre o nível de compreensão do colaborador,
pensada pra apoiar o gestor da área a identificar pontos fortes e lacunas
de conhecimento na equipe.

Classifique a resposta em uma das três categorias:
- "adequada": a resposta demonstra entendimento correto e completo do conceito perguntado.
- "parcial": a resposta está no caminho certo, mas tem lacunas, imprecisões ou está incompleta.
- "inadequada": a resposta está incorreta, muito vaga, em branco, ou não demonstra entendimento do tema.

Escreva um comentário de 2 a 3 frases, direto e objetivo, explicando o
porquê da classificação — o que a resposta acertou e/ou o que faltou.
Escreva para um gestor não-técnico entender rápido, sem jargão. Nunca
invente informação que não esteja na resposta do colaborador.`;

const FERRAMENTA_AVALIACAO = {
  name: 'registrar_avaliacao',
  description: 'Registra a avaliação qualitativa de uma resposta dissertativa de colaborador.',
  input_schema: {
    type: 'object',
    properties: {
      avaliacao: { type: 'string', enum: ['adequada', 'parcial', 'inadequada'] },
      comentario: {
        type: 'string',
        description: 'Comentário de 2 a 3 frases explicando a classificação, escrito para o gestor.'
      }
    },
    required: ['avaliacao', 'comentario']
  }
};

async function avaliarComIA(client, enunciado, resposta) {
  const respostaTexto = resposta && String(resposta).trim() ? String(resposta).trim() : '(sem resposta / em branco)';
  const msg = await client.messages.create({
    model: MODELO,
    max_tokens: 500,
    system: PROMPT_SISTEMA,
    tools: [FERRAMENTA_AVALIACAO],
    tool_choice: { type: 'tool', name: 'registrar_avaliacao' },
    messages: [{
      role: 'user',
      content: `Pergunta: ${enunciado}\n\nResposta do colaborador: ${respostaTexto}`
    }]
  });

  const usoFerramenta = msg.content.find((bloco) => bloco.type === 'tool_use');
  if (!usoFerramenta || !usoFerramenta.input) {
    throw new Error('A IA não retornou uma avaliação estruturada.');
  }
  const { avaliacao, comentario } = usoFerramenta.input;
  if (!['adequada', 'parcial', 'inadequada'].includes(avaliacao)) {
    throw new Error('Avaliação inválida retornada pela IA: ' + avaliacao);
  }
  return { avaliacao, comentario: String(comentario || '').trim().slice(0, 600) };
}

// Callable (chamada pelo Admin via httpsCallable — exige login: request.auth
// vem do token do Firebase Auth do admin logado, igual toda outra escrita
// nessa coleção). Recebe um lote de perguntas abertas pra avaliar e grava
// o resultado de cada uma direto em avaliacoes_abertas.
exports.avaliarRespostasAbertas = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Só um admin logado pode gerar avaliações com IA.');
  }

  const itens = request.data && request.data.itens;
  if (!Array.isArray(itens) || itens.length === 0) {
    throw new HttpsError('invalid-argument', 'Envie ao menos um item em "itens".');
  }
  if (itens.length > MAX_ITENS_POR_CHAMADA) {
    throw new HttpsError('invalid-argument', `No máximo ${MAX_ITENS_POR_CHAMADA} itens por chamada.`);
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

  const resultados = await Promise.all(itens.map(async (item) => {
    const resultadoId = item && item.resultadoId;
    const questaoIdx = item && item.questaoIdx;
    const enunciado = item && item.enunciado;
    const docId = resultadoId != null && questaoIdx != null ? `${resultadoId}_${questaoIdx}` : null;

    if (!resultadoId || typeof questaoIdx !== 'number' || !enunciado) {
      return { docId, ok: false, erro: 'item inválido (faltou resultadoId, questaoIdx ou enunciado)' };
    }
    try {
      const avaliacao = await avaliarComIA(client, enunciado, item.resposta);
      const dados = {
        resultadoId,
        questaoIdx,
        avaliacao: avaliacao.avaliacao,
        comentario: avaliacao.comentario,
        avaliadoPor: AVALIADO_POR_IA,
        avaliadoEm: new Date().toISOString()
      };
      await db.collection('avaliacoes_abertas').doc(docId).set(dados);
      return { docId, ok: true, ...dados };
    } catch (e) {
      console.error('[avaliarRespostasAbertas] Erro no item', docId, e);
      return { docId, ok: false, erro: String((e && e.message) || e) };
    }
  }));

  return { resultados };
});
