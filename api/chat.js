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

async function groqCall(messages, model = 'deepseek-r1-distill-llama-70b', maxTokens = 2000) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
  return data.choices?.[0]?.message?.content || '';
}

async function rewriteQuery(userMessage, conversationHistory) {
  // Fix spelling, resolve followup references, make query self-contained
  const history = conversationHistory
    .slice(-4)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const rewritten = await groqCall([
    {
      role: 'system',
      content: `You are a query rewriter. Given a conversation history and a user question, rewrite the question to:
1. Fix any spelling mistakes
2. Resolve any followup references (e.g. "what about that?" → make it explicit)
3. Make it a complete, self-contained search query
4. Keep it concise — one clear question

Return ONLY the rewritten query, nothing else.`
    },
    {
      role: 'user',
      content: `Conversation so far:\n${history}\n\nUser's latest message: "${userMessage}"\n\nRewrite this into a clear search query:`
    }
  ], 'llama-3.3-70b-versatile', 200);

  return rewritten.trim() || userMessage;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, paperId, conversationHistory = [] } = req.body;

    // Step 1: Rewrite query — fix spelling, resolve followups
    const cleanQuery = await rewriteQuery(message, conversationHistory);

    // Step 2: Get embedding for cleaned query
    const embedding = await getEmbedding(cleanQuery);

    // Step 3: Retrieve top 10 most relevant chunks
    const { data: chunks, error: chunkError } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_paper_id: paperId,
      match_count: 10
    });

    if (chunkError) throw new Error(chunkError.message);

    const context = chunks
      .map((c, i) => `[Section ${i + 1}]\n${c.content}`)
      .join('\n\n---\n\n');

    // Step 4: Build conversation history (last 6 messages)
    const recentHistory = conversationHistory.slice(-6);

    // Step 5: DeepSeek R1 for deep reasoning
    const reply = await groqCall([
      {
        role: 'system',
        content: `You are a world-class research analyst and domain expert who has deeply studied the research paper provided below. You think rigorously, reason carefully, and give precise, actionable answers.

YOUR APPROACH:
- You do not just quote the paper. You REASON from it like a domain expert.
- Apply the paper's findings, equations, methodology, and conclusions to answer the user's specific question.
- If the user provides their context (district, budget, population type), tailor your answer specifically to their situation.
- Think step by step — identify what the user actually needs, find relevant findings, apply the logic, give a clear answer.
- Cite specific numbers, formulas, and findings to back your reasoning.
- Distinguish between what the paper directly states vs what you are inferring.
- If something is genuinely not covered, say so clearly.
- Understand that users may have typos or ask followup questions — always interpret charitably and helpfully.

OUTPUT FORMAT:
- Direct answer first
- Reasoning using paper's findings with specific numbers
- Practical recommendation if applicable
- Keep it clear, structured, actionable

RESEARCH PAPER CONTEXT:
${context}`
      },
      ...recentHistory,
      {
        role: 'user',
        content: message
      }
    ]);

    // Clean DeepSeek thinking tags if present
    const cleanReply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    res.status(200).json({ 
      reply: cleanReply,
      queryUsed: cleanQuery
    });

  } catch(err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
