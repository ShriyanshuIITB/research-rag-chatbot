import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

  const { message, paperId } = req.body;

  // Get embedding for the question
  const embedding = await getEmbedding(message);

  // Find relevant chunks from Supabase
  const { data: chunks } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_paper_id: paperId,
    match_count: 5
  });

  const context = chunks.map(c => c.content).join('\n\n');

  // Ask Groq with context
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `You are a research assistant. Answer questions based ONLY on this research paper context. If the answer is not in the context, say so clearly.\n\nCONTEXT:\n${context}`
      },
      { role: 'user', content: message }
    ]
  });

  res.status(200).json({
    reply: completion.choices[0].message.content
  });
}
