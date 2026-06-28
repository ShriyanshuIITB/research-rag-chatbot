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
      max_tokens: 200,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are a query rewriter. Given conversation history and a user question:
1. Fix spelling mistakes
2. Resolve followup references ("what about that?" → make explicit)
3. Make it a complete self-contained search query
Return ONLY the rewritten query, nothing else.`
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

async function geminiChat(systemPrompt, conversationHistory, userMessage) {
  const contents = [];
  
  for (const msg of conversationHistory.slice(-6)) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }
  
  contents.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          topP: 0.8
        }
      })
    }
  );

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error?.message || 'Gemini API error');
  }
  
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response received.';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, paperId, conversationHistory = [] } = req.body;

    // Step 1: Rewrite query using Groq (fast, free)
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

    // Step 4: Gemini 1.5 Flash for deep reasoning
    const systemPrompt = `You are a world-class research analyst and domain expert who has deeply studied the research paper provided below. You think rigorously, reason carefully, and give precise, actionable answers.

YOUR APPROACH:
- You do not just quote the paper. You REASON from it like a domain expert.
- Apply the paper's findings, equations, methodology, and conclusions to answer the user's specific question.
- If the user provides their context (district, budget, population), tailor your answer specifically to their situation using the paper's framework.
- Think step by step — identify what the user actually needs, find the relevant findings, apply the logic, give a clear answer.
- Cite specific numbers, formulas, and findings from the paper to back your reasoning.
- Distinguish between what the paper directly states vs what you are inferring from its framework.
- If something is genuinely not covered in the paper, say so clearly and honestly.
- Understand that users may have typos or ask followup questions — always interpret charitably and helpfully.
- You have memory of the conversation — use it to give coherent followup answers.

OUTPUT FORMAT:
- Direct answer first
- Reasoning using paper's findings with specific numbers
- Practical recommendation if applicable
- Clear, structured, actionable

RESEARCH PAPER CONTEXT (10 most relevant sections):
${context}

Remember: You are not a search engine. You are a domain expert who has internalized this research and applies it to real-world problems.`;

    const reply = await geminiChat(systemPrompt, conversationHistory, message);

    res.status(200).json({ reply });

  } catch(err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API call failed', detail: err.message });
  }
}
