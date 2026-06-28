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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, paperId } = req.body;

    const embedding = await getEmbedding(message);

    const { data: chunks } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_paper_id: paperId,
      match_count: 5
    });

    const context = chunks.map(c => c.content).join('\n\n');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `You are a strict research assistant. Follow these rules absolutely:
1. Answer ONLY using the exact text provided in CONTEXT below.
2. If the answer is not clearly stated in CONTEXT, say exactly: "This specific information is not available in the retrieved sections of the paper."
3. Never guess, infer, or fill gaps with outside knowledge.
4. For numbers, formulas, and statistics — quote them exactly as they appear.
5. If a formula appears incomplete or unclear, say so honestly.

CONTEXT:
${context}`
          },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await response.json();
    res.status(200).json({ reply: data.choices?.[0]?.message?.content || 'No response received.' });

  } catch(err) {
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
