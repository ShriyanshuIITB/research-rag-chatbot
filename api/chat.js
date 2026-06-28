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
    const { message, paperId, conversationHistory } = req.body;

    // Step 1: Get embedding for the question
    const embedding = await getEmbedding(message);

    // Step 2: Retrieve top 10 most relevant chunks
    const { data: chunks, error: chunkError } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_paper_id: paperId,
      match_count: 10
    });

    if (chunkError) throw new Error(chunkError.message);

    // Step 3: Build rich context with chunk numbering
    const context = chunks
      .map((c, i) => `[Section ${i + 1}]\n${c.content}`)
      .join('\n\n---\n\n');

    // Step 4: Build conversation history for multi-turn
    const history = conversationHistory || [];

    // Step 5: Call Groq with deep reasoning prompt
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
- You apply the paper's findings, equations, methodology, and conclusions to answer the user's specific question.
- If the user provides their context (district, budget, population), you tailor your answer specifically to their situation using the paper's framework.
- You think step by step — identify what the user actually needs, find the relevant findings, apply the logic, give a clear answer.
- You cite specific numbers, formulas, and findings from the paper to back your reasoning.
- You distinguish between what the paper directly states vs what you are inferring from its framework.
- If something is genuinely not covered in the paper, you say so clearly and honestly.

YOUR OUTPUT FORMAT:
- Start with a direct answer to the question
- Then explain the reasoning using paper's findings
- Use specific numbers and data points from the paper
- End with a practical recommendation if applicable
- Keep it clear, structured, and actionable

RESEARCH PAPER CONTEXT (10 most relevant sections):
${context}

Remember: You are not a search engine returning chunks. You are a domain expert who has internalized this research and can apply it to real-world problems.`
          },
          ...history,
          {
            role: 'user',
            content: message
          }
        ]
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'Groq API error');
    }

    const reply = data.choices?.[0]?.message?.content || 'No response received.';

    res.status(200).json({ reply });

  } catch(err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
