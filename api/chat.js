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

    const cleanQuery = await rewriteQuery(message, conversationHistory);
    const embedding = await getEmbedding(cleanQuery);

    const { data: chunks, error: chunkError } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_paper_id: paperId,
      match_count: 10
    });

    if (chunkError) throw new Error(chunkError.message);

    const context = chunks
      .map((c, i) => `[Section ${i + 1}]\n${c.content}`)
      .join('\n\n---\n\n');

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
            content: `You are a world-class research analyst and domain expert who has deeply studied the research paper provided below. You think rigorously, reason carefully, and give precise, actionable answers.

YOUR APPROACH:
- You do not just quote the paper. You REASON from it like a domain expert.
- Apply the paper's findings, equations, methodology, and conclusions to answer the user's specific question.
- If the user provides their context (district, budget, population), tailor your answer specifically to their situation.
- Think step by step — identify what the user needs, find relevant findings, apply the logic, give a clear answer.
- Cite specific numbers, formulas, and findings to back your reasoning.
- Understand typos and followup questions — always interpret charitably.
- Use conversation history for coherent followup answers.

OUTPUT:
- Direct answer first
- Reasoning with specific numbers from paper
- Practical recommendation
- Clear, structured, actionable

PAPER CONTEXT:
${context}`
          },
          ...recentHistory,
          { role: 'user', content: message }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq error');

    res.status(200).json({ reply: data.choices?.[0]?.message?.content || 'No response received.' });

  } catch(err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
