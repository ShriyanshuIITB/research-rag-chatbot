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

async function rewriteQueryWithHistory(userMessage, conversationHistory) {
  if (conversationHistory.length === 0) return userMessage;
  const history = conversationHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
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
          content: 'You are a query rewriter. Given the conversation history and the latest user message, rewrite the latest message into a self‑contained question that includes all necessary context. Return ONLY the rewritten question.'
        },
        {
          role: 'user',
          content: `Conversation history:\n${history}\n\nLatest user message: "${userMessage}"\n\nRewritten question:`
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

    // Get paper info
    const { data: paper } = await supabase
      .from('papers')
      .select('title, description')
      .eq('id', paperId)
      .single();
    const paperTopic = paper?.title || 'this research paper';

    // 1. Rewrite query with conversation context
    const contextualQuery = await rewriteQueryWithHistory(message, conversationHistory);

    // 2. Get embedding
    const embedding = await getEmbedding(contextualQuery);

    // 3. Retrieve top 10 chunks (no threshold)
    const { data: chunks, error: chunkError } = await supabase.rpc('match_chunks_with_score', {
      query_embedding: embedding,
      match_paper_id: paperId,
      match_count: 10
    });

    if (chunkError) {
      console.error('RPC error:', chunkError);
      return res.status(500).json({ error: 'Retrieval failed' });
    }

    if (!chunks || chunks.length === 0) {
      return res.status(200).json({
        reply: `I couldn't find any relevant sections in the paper to answer your question. Please try rephrasing or ask about the paper's content.`
      });
    }

    // 4. Build context from chunks
    const context = chunks
      .map((c, i) => `[Excerpt ${i+1}]\n${c.content}`)
      .join('\n\n---\n\n');

    // 5. Prepare conversation history for LLM (last 10 turns)
    const historyForLLM = conversationHistory.slice(-10);

    // 6. Call Groq with the new prompt
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are an expert research assistant for the paper: "${paperTopic}".

You have been given relevant excerpts from the paper as CONTEXT.  
Your goal is to help the user understand the paper’s findings, apply its methodology, and answer questions—even those that go beyond what is explicitly stated, as long as you can logically derive the answer from the paper’s content.

RULES:
1. Use ONLY the provided CONTEXT as your source of truth. Do NOT use external knowledge.
2. You MAY combine information from different excerpts, perform calculations, and apply the paper’s frameworks to new scenarios.
3. If the question cannot be answered even with reasoning from the context, politely say: “I cannot find enough information in the paper to answer this fully. However, based on what the paper says about X, you might consider Y.”
4. Always cite specific numbers, equations, or findings from the context when possible.
5. If the user asks for policy recommendations, you may suggest options that are consistent with the paper’s conclusions.

CONTEXT:
${context}`
          },
          ...historyForLLM,
          { role: 'user', content: message }  // use original message (or contextualQuery) – keep original for clarity
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq error');

    const reply = data.choices?.[0]?.message?.content || 'No response received.';

    // Log the question (answered always, since we no longer have a strict out-of-scope)
    await supabase.from('question_logs').insert({
      paper_id: paperId,
      question: message,
      answered: true   // we always try to answer; we can adjust later
    }).catch(() => {});

    return res.status(200).json({ reply });

  } catch(err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
