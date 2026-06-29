import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getEmbedding(text) {
  const response = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`
    },
    body: JSON.stringify({
      input: [text],
      model: 'jina-embeddings-v2-base-en'
    })
  });
  const data = await response.json();
  return data.data[0].embedding;
}

async function rewriteQuery(userMessage, conversationHistory) {
  const history = conversationHistory
    .slice(-4)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 150,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are a query rewriter. Fix spelling mistakes, resolve followup references, make the question self-contained. Return ONLY the rewritten query.`
        },
        {
          role: 'user',
          content: `Conversation:\n${history}\n\nUser message: "${userMessage}"\n\nRewrite:`
        }
      ]
    })
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || userMessage;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, paperId, conversationHistory = [] } = req.body;

    // Step 1: Get paper info to know what topic it covers
    const { data: paper } = await supabase
      .from('papers')
      .select('title, description')
      .eq('id', paperId)
      .single();

    const paperTopic = paper?.title || 'this research paper';

    // Step 2: Rewrite query
    const cleanQuery = await rewriteQuery(message, conversationHistory);

    // Step 3: Get embedding
    const embedding = await getEmbedding(cleanQuery);

    // Step 4: Retrieve chunks WITH similarity scores
    const { data: chunks, error: chunkError } = await supabase.rpc('match_chunks_with_score', {
      query_embedding: embedding,
      match_paper_id: paperId,
      match_count: 10
    });

    if (chunkError) {
      // Fallback to original function if new one doesn't exist yet
      const { data: fallbackChunks } = await supabase.rpc('match_chunks', {
        query_embedding: embedding,
        match_paper_id: paperId,
        match_count: 10
      });

      if (!fallbackChunks || fallbackChunks.length === 0) {
        const reply = data.choices?.[0]?.message?.content || 'No response received.';
    
    // Log the question
    const answered = !reply.includes('outside the scope');
    await supabase.from('question_logs').insert({
      paper_id: paperId,
      question: message,
      answered
    }).catch(() => {}); // Don't fail if logging fails

    return res.status(200).json({ reply });
      }

      const context = fallbackChunks
        .map((c, i) => `[Section ${i + 1}]\n${c.content}`)
        .join('\n\n---\n\n');

      return await answerWithContext(context, message, conversationHistory, paperTopic, res);
    }

    // Step 5: Check similarity threshold
    const SIMILARITY_THRESHOLD = 0.3;
    const relevantChunks = chunks.filter(c => c.similarity > SIMILARITY_THRESHOLD);

    if (relevantChunks.length === 0) {
      return res.status(200).json({
        reply: `This question appears to be outside the scope of this paper. This paper covers "${paperTopic}". I can only answer questions related to the paper's actual content. Please ask something related to the paper's research findings, methodology, or conclusions.`
      });
    }

    const context = relevantChunks
      .map((c, i) => `[Section ${i + 1}]\n${c.content}`)
      .join('\n\n---\n\n');

    return await answerWithContext(context, message, conversationHistory, paperTopic, res);

  } catch(err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}

async function answerWithContext(context, message, conversationHistory, paperTopic, res) {
  const recentHistory = conversationHistory.slice(-6);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a strict research assistant for the paper: "${paperTopic}".

CRITICAL RULES — NEVER BREAK THESE:
1. Answer ONLY using information from the CONTEXT provided below.
2. If the context does not contain relevant information to answer the question, respond EXACTLY with: "This question is outside the scope of this paper. This paper covers '${paperTopic}'. Please ask a question related to the paper's content."
3. NEVER use external knowledge, general knowledge, or anything not in the context.
4. NEVER make up statistics, figures, costs, or facts not in the context.
5. If you are even slightly unsure whether the context supports your answer, say so clearly.
6. You ARE allowed to reason and synthesize from the context — but only from the context.

WHEN YOU CAN ANSWER:
- Reason deeply from the paper's findings
- Apply the paper's framework to the user's specific situation
- Cite specific numbers and findings from the context
- Give practical, actionable recommendations based on the paper

CONTEXT FROM PAPER:
${context}`
        },
        ...recentHistory,
        { role: 'user', content: message }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq error');

  const reply = data.choices?.[0]?.message?.content || 'No response received.';

  // Log the question
  const answered = !reply.includes('outside the scope');
  await supabase.from('question_logs').insert({
    paper_id: paperId,
    question: message,
    answered
  }).catch(() => {});

  return res.status(200).json({ reply });
}
